import { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startLocalApi } from './api-server.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const appUrl = 'folio://app/index.html'
const maxPdfBytes = 512 * 1024 * 1024
const isDevelopment = !app.isPackaged
// Keep the original profile and its PDF history, font cache, and agent workspaces.
// Setting a new application name must not select a new default userData directory.
app.setPath('userData', isDevelopment && process.env.FOLIO_USER_DATA_DIR
  ? path.resolve(process.env.FOLIO_USER_DATA_DIR)
  : path.join(app.getPath('appData'), 'Folio PDF'))
app.setName('ExPDF')
protocol.registerSchemesAsPrivileged([{ scheme: 'folio', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }])

let window
let rendererReady = false
let servicesReady = false
let quitting = false
let closing = false
let closeNonce
let closeTimer
let api
let stopping = false
const pendingFiles = []
let pendingOpen = false
let drainingFiles = false
const sources = new Map()
const pendingSaves = new Set()
const registryPath = () => path.join(app.getPath('userData'), 'native-files.json')
const agentWorkspaceRoot = () => path.join(app.getPath('userData'), 'agent-workspaces')
const agentDocumentExtensions = new Set(['.pdf', '.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.docx', '.xlsx', '.pptx', '.rtf', '.odt', '.ods', '.odp', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.html', '.htm'])
let registryWrites = Promise.resolve()

function persistSources() {
  const contents = JSON.stringify(Object.fromEntries(sources))
  registryWrites = registryWrites.catch(() => {}).then(async () => {
    await fs.mkdir(app.getPath('userData'), { recursive: true })
    const temporary = `${registryPath()}.tmp`
    await fs.writeFile(temporary, contents, { mode: 0o600 })
    await fs.rename(temporary, registryPath())
  })
  return registryWrites
}
async function loadSources() {
  try {
    const saved = JSON.parse(await fs.readFile(registryPath(), 'utf8'))
    for (const [id, entry] of Object.entries(saved)) {
      if (/^[a-f0-9]{32}$/.test(id) && entry && typeof entry.path === 'string' && path.isAbsolute(entry.path)) sources.set(id, entry)
    }
  } catch { /* First launch has no native file grants. */ }
}
function pdfBytes(value) {
  if (!(value instanceof Uint8Array) || !value.length || value.length > maxPdfBytes) throw new Error('PDF 文件无效或超过 512 MB。')
  const bytes = Buffer.from(value)
  if (!bytes.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw new Error('请选择有效的 PDF 文件。')
  return bytes
}
async function registerSource(filename, stat) {
  const existing = [...sources].find(([, entry]) => entry.path === filename)
  const id = existing?.[0] || randomBytes(16).toString('hex')
  sources.set(id, { path: filename, size: stat.size, mtimeMs: stat.mtimeMs })
  await persistSources()
  return id
}
async function readPdf(filename) {
  const realPath = await fs.realpath(filename)
  if (path.extname(realPath).toLowerCase() !== '.pdf') throw new Error('请选择 PDF 文件。')
  const stat = await fs.stat(realPath)
  if (!stat.isFile() || stat.size > maxPdfBytes) throw new Error('无法打开该文件，PDF 最大支持 512 MB。')
  const bytes = pdfBytes(await fs.readFile(realPath))
  const sourceId = await registerSource(realPath, stat)
  app.addRecentDocument(realPath)
  return { name: path.basename(realPath), bytes: new Uint8Array(bytes), sourceId }
}
function trusted(event) {
  return window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === appUrl
}
function requireTrusted(event) {
  if (!trusted(event)) throw new Error('此操作仅供阅读器主窗口使用。')
}
async function openPdf() {
  const result = await dialog.showOpenDialog(window, { title: '打开 PDF', properties: ['openFile'], filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] })
  return result.canceled || !result.filePaths[0] ? null : readPdf(result.filePaths[0])
}
async function openPdfs() {
  const result = await dialog.showOpenDialog(window, { title: '打开 PDF', properties: ['openFile', 'multiSelections'], filters: [{ name: 'PDF 文档', extensions: ['pdf'] }] })
  if (result.canceled) return []
  const documents = []
  for (const filename of result.filePaths) documents.push(await readPdf(filename))
  return documents
}
async function openAgentFile(options) {
  try {
    if (!options || typeof options !== 'object' || typeof options.path !== 'string' || !options.path || options.path.length > 8192 || options.path.includes('\0') || (options.reveal !== undefined && typeof options.reveal !== 'boolean')) throw new Error('文件链接无效。')
    let requested = options.path
    if (/^file:/i.test(requested)) requested = fileURLToPath(new URL(requested))
    else requested = decodeURIComponent(requested)
    if (!path.isAbsolute(requested)) throw new Error('请使用生成文件的完整路径。')
    const userData = await fs.realpath(app.getPath('userData'))
    const workspace = path.join(userData, 'agent-workspaces')
    if (await fs.realpath(agentWorkspaceRoot()) !== workspace) throw new Error('工作目录无效，请重新启动 ExPDF。')
    const target = await fs.realpath(requested)
    const relative = path.relative(workspace, target)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('只能打开 ExPDF 代理工作目录中的文件。')
    const stat = await fs.stat(target)
    if (stat.isDirectory()) {
      if (/\.(?:app|bundle|workflow|plugin|framework)$/i.test(target)) throw new Error('不能从回答中运行应用或脚本。')
    } else if (!stat.isFile() || !agentDocumentExtensions.has(path.extname(target).toLowerCase()) || (process.platform !== 'win32' && (stat.mode & 0o111))) throw new Error('只能打开生成的文档或图片，不能运行程序或脚本。')
    if (options.reveal) shell.showItemInFolder(target)
    else { const error = await shell.openPath(target); if (error) throw new Error(error) }
    return { ok: true }
  } catch (error) { return { ok: false, error: error.code === 'ENOENT' ? '生成文件已不存在。' : error.message || '无法打开生成文件。' } }
}
async function savePdf(options) {
  if (!options || typeof options !== 'object') throw new Error('保存参数无效。')
  const bytes = pdfBytes(options.bytes)
  const suggestedName = path.basename(typeof options.suggestedName === 'string' ? options.suggestedName : '未命名.pdf').replace(/[\x00-\x1f]/g, '') || '未命名.pdf'
  const source = typeof options.sourceId === 'string' ? sources.get(options.sourceId) : undefined
  let destination = !options.saveAs && source?.path
  if (destination) {
    try {
      const stat = await fs.stat(destination)
      if (stat.mtimeMs !== source.mtimeMs || stat.size !== source.size) {
        const decision = await dialog.showMessageBox(window, { type: 'warning', message: '此 PDF 已被其他程序修改', detail: '你可以另存一份，或用当前阅读器中的版本覆盖它。', buttons: ['另存为…', '覆盖', '取消'], defaultId: 0, cancelId: 2 })
        if (decision.response === 2) return { canceled: true }
        if (decision.response === 0) destination = undefined
      }
    } catch (error) { if (error.code === 'ENOENT') destination = undefined; else throw error }
  }
  if (!destination) {
    const result = await dialog.showSaveDialog(window, { title: '另存为 PDF', defaultPath: source ? path.join(path.dirname(source.path), suggestedName) : suggestedName, filters: [{ name: 'PDF 文档', extensions: ['pdf'] }], properties: ['createDirectory', 'showOverwriteConfirmation'] })
    if (result.canceled || !result.filePath) return { canceled: true }
    destination = result.filePath
    if (path.extname(destination).toLowerCase() !== '.pdf') destination += '.pdf'
  }
  // Resolve an existing symlink before replacing the user-granted file atomically.
  destination = await fs.realpath(destination).catch(error => { if (error.code === 'ENOENT') return destination; throw error })
  let mode = 0o600
  try { mode = (await fs.stat(destination)).mode & 0o777 } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = path.join(path.dirname(destination), `.folio-${randomBytes(12).toString('hex')}.pdf`)
  try {
    await fs.writeFile(temporary, bytes, { mode, flag: 'wx' })
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  const sourceId = await registerSource(destination, await fs.stat(destination))
  app.addRecentDocument(destination)
  return { canceled: false, name: path.basename(destination), sourceId }
}
function command(action) {
  if (action === 'open' && !rendererReady) { pendingOpen = true; return }
  if (rendererReady && window && !window.isDestroyed()) window.webContents.send('desktop:command', action)
}
async function flushOpenFiles() {
  if (drainingFiles || !rendererReady || !window || window.isDestroyed()) return
  drainingFiles = true
  try {
    while (pendingFiles.length && rendererReady && window && !window.isDestroyed()) {
      const target = window
      const filename = pendingFiles.shift()
      try {
        const pdf = await readPdf(filename)
        if (target !== window || target.isDestroyed() || !rendererReady || closing) { pendingFiles.unshift(filename); break }
        target.webContents.send('desktop:open-pdf-data', pdf)
      } catch (error) {
        if (target === window && !target.isDestroyed()) await dialog.showMessageBox(target, { type: 'error', message: '无法打开 PDF', detail: error.message })
      }
    }
  } finally {
    drainingFiles = false
    if (pendingFiles.length && rendererReady && !closing) setImmediate(() => void flushOpenFiles())
  }
}
function queueFile(filename) {
  if (typeof filename !== 'string' || path.extname(filename).toLowerCase() !== '.pdf') return
  pendingFiles.push(filename)
  if (servicesReady) {
    if (!window || window.isDestroyed()) createWindow()
    else { window.show(); window.focus() }
    void flushOpenFiles()
  }
}
function finishClose() {
  clearTimeout(closeTimer)
  closeNonce = undefined
  if (window && !window.isDestroyed()) window.destroy()
  if (quitting) app.quit()
}
function createWindow() {
  if (!servicesReady || (window && !window.isDestroyed())) return
  rendererReady = false
  closing = false
  window = new BrowserWindow({
    width: 1440, height: 1000, minWidth: 900, minHeight: 620, title: 'ExPDF', backgroundColor: '#242427',
    show: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { preload: path.join(root, 'desktop/preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, webviewTag: false, backgroundThrottling: !(isDevelopment && process.env.FOLIO_START_HIDDEN === '1') },
  })
  window.once('ready-to-show', () => { if (!(isDevelopment && process.env.FOLIO_START_HIDDEN === '1')) window.show() })
  window.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' } })
  window.webContents.on('will-navigate', (event, url) => { if (url !== appUrl) { event.preventDefault(); openExternal(url) } })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('close', event => {
    if (!rendererReady) return
    event.preventDefault()
    if (closing) return
    closing = true
    closeNonce = randomBytes(16).toString('hex')
    window.webContents.send('desktop:prepare-close', closeNonce)
    closeTimer = setTimeout(finishClose, 5000)
  })
  window.on('closed', () => { rendererReady = false; clearTimeout(closeTimer); window = undefined })
  void window.loadURL(appUrl)
}
function openExternal(value) {
  try {
    const url = new URL(value)
    if (['https:', 'http:'].includes(url.protocol)) void shell.openExternal(url.href)
  } catch { /* Unsupported navigation stays inside the app. */ }
}
function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'ExPDF', submenu: [{ role: 'about', label: '关于 ExPDF' }, { type: 'separator' }, { role: 'services', label: '服务' }, { type: 'separator' }, { role: 'hide', label: '隐藏 ExPDF' }, { role: 'hideOthers', label: '隐藏其他' }, { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出 ExPDF' }] },
    { label: '文件', submenu: [
      { label: '打开 PDF…', accelerator: 'CmdOrCtrl+O', click: () => { if (!window || window.isDestroyed()) createWindow(); command('open') } },
      { type: 'separator' }, { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => command('save') },
      { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: () => command('saveAs') },
      { type: 'separator' }, { role: 'recentDocuments', label: '最近打开', submenu: [{ role: 'clearRecentDocuments', label: '清除菜单' }] },
      { type: 'separator' }, { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => command('closeTab') },
      { role: 'close', label: '关闭窗口', accelerator: 'CmdOrCtrl+Shift+W' },
    ] },
    { label: '编辑', submenu: [
      { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => command('undo') },
      { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => command('redo') },
      { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' },
    ] },
    { label: '显示', submenu: [{ role: 'togglefullscreen', label: '进入全屏' }, ...(isDevelopment ? [{ role: 'toggleDevTools', label: '开发者工具' }] : [])] },
    { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放窗口' }, { type: 'separator' }, { role: 'front', label: '前置全部窗口' }] },
  ]))
}
async function findCodex() {
  const directories = [...(process.env.PATH || '').split(path.delimiter), path.join(app.getPath('home'), '.volta/bin'), path.join(app.getPath('home'), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  try {
    const nvm = path.join(app.getPath('home'), '.nvm/versions/node')
    const versions = (await fs.readdir(nvm)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    directories.push(...versions.map(version => path.join(nvm, version, 'bin')))
  } catch { /* nvm is optional. */ }
  for (const directory of new Set(directories.filter(Boolean))) {
    const candidate = path.join(directory, 'codex')
    try { await fs.access(candidate, 0o1); return candidate } catch { /* Try the next installed CLI. */ }
  }
}
const contentSecurityPolicy = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self' blob: data:; img-src 'self' blob: data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'"
async function installProtocol() {
  const token = randomBytes(32).toString('hex')
  await fs.mkdir(agentWorkspaceRoot(), { recursive: true, mode: 0o700 })
  api = await startLocalApi({ token, codexPath: await findCodex(), workspaceRoot: agentWorkspaceRoot() })
  const distRoot = path.join(root, 'dist')
  protocol.handle('folio', async request => {
    const url = new URL(request.url)
    if (url.hostname !== 'app') return new Response('Not found', { status: 404 })
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return new Response('Invalid path', { status: 400 }) }
    if (pathname.startsWith('/api/')) {
      const allowed = /^\/api\/(?:fonts(?:\/[a-f0-9]{64})?|codex\/(?:status|models|ask|agent\/(?:status|run|respond|interrupt)))$/.test(pathname)
      if (!allowed) return new Response('Not found', { status: 404 })
      const post = pathname === '/api/codex/ask' || /^\/api\/codex\/agent\/(?:run|respond|interrupt)$/.test(pathname)
      if (request.method !== (post ? 'POST' : 'GET')) return new Response('Method not allowed', { status: 405 })
      try {
        const response = await fetch(`${api.origin}${pathname}${url.search}`, {
          method: request.method, headers: { 'X-Folio-Token': token, ...(post ? { 'Content-Type': 'application/json' } : {}) },
          ...(post ? { body: await request.arrayBuffer() } : {}), signal: request.signal,
        })
        return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
      } catch { return new Response(JSON.stringify({ error: '本机服务暂不可用。' }), { status: 503, headers: { 'Content-Type': 'application/json' } }) }
    }
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', { status: 405 })
    if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..')) return new Response('Invalid path', { status: 403 })
    const filename = path.resolve(distRoot, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (!filename.startsWith(`${distRoot}${path.sep}`)) return new Response('Invalid path', { status: 403 })
    try {
      const response = await net.fetch(pathToFileURL(filename).href)
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', contentSecurityPolicy)
      headers.set('X-Content-Type-Options', 'nosniff')
      const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.otf': 'font/otf', '.ttf': 'font/ttf' }[path.extname(filename)]
      if (mime) headers.set('Content-Type', mime)
      return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
    } catch { return new Response('Not found', { status: 404 }) }
  })
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('open-file', (event, filename) => { event.preventDefault(); queueFile(filename) })
  app.on('second-instance', (_event, argv) => { for (const value of argv.slice(1)) if (path.isAbsolute(value)) queueFile(value); window?.show(); window?.focus() })
  for (const value of process.argv.slice(1)) if (path.isAbsolute(value) && path.extname(value).toLowerCase() === '.pdf') pendingFiles.push(value)
  ipcMain.handle('desktop:open-pdf', event => { requireTrusted(event); return openPdf() })
  ipcMain.handle('desktop:open-pdfs', event => { requireTrusted(event); return openPdfs() })
  ipcMain.handle('desktop:open-agent-file', (event, options) => { requireTrusted(event); return openAgentFile(options) })
  ipcMain.handle('desktop:save-pdf', async (event, options) => {
    requireTrusted(event)
    const pending = savePdf(options)
    pendingSaves.add(pending)
    try { return await pending } finally { pendingSaves.delete(pending) }
  })
  ipcMain.handle('desktop:ready', event => { requireTrusted(event); rendererReady = true; void flushOpenFiles(); if (pendingOpen) { pendingOpen = false; command('open') } })
  ipcMain.on('desktop:set-document', (event, value) => {
    if (!trusted(event) || !value || typeof value.name !== 'string') return
    window.setTitle(`${value.name.slice(0, 240)} — ExPDF`)
    window.setRepresentedFilename(sources.get(value.sourceId)?.path || '')
  })
  ipcMain.handle('desktop:did-flush', (event, nonce) => { requireTrusted(event); if (closing && nonce === closeNonce) setImmediate(finishClose) })
  app.on('before-quit', () => { quitting = true })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
  app.on('activate', () => { if (!window || window.isDestroyed()) createWindow(); else window.show() })
  app.on('will-quit', event => {
    if (stopping) return
    event.preventDefault()
    stopping = true
    Promise.allSettled([...pendingSaves]).then(() => Promise.allSettled([api?.close(), registryWrites])).finally(() => app.exit(0))
  })
  app.whenReady().then(async () => {
    await loadSources()
    await installProtocol()
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => callback(permission === 'clipboard-sanitized-write' && webContents === window?.webContents && webContents.getURL() === appUrl))
    session.defaultSession.setPermissionCheckHandler((webContents, permission) => permission === 'clipboard-sanitized-write' && webContents === window?.webContents && webContents.getURL() === appUrl)
    session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (_details, callback) => callback({ cancel: true }))
    installMenu()
    servicesReady = true
    app.setAboutPanelOptions({
      applicationName: 'ExPDF', applicationVersion: app.getVersion(),
      copyright: '本地 PDF 阅读 · 批注 · Codex 助手',
      credits: '直接接入本机 Codex 的 PDF 阅读器。\n通过本机 Codex CLI 使用已有订阅额度。',
    })
    createWindow()
  }).catch(error => { dialog.showErrorBox('ExPDF 启动失败', error.message); app.exit(1) })
}
