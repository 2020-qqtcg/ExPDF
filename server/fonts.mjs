import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isIP } from 'node:net'
import path from 'node:path'
import fontkit from '@pdf-lib/fontkit'

const fontExtensions = /\.(?:ttf|otf|ttc|otc|dfont|woff2?)$/i

async function directories() {
  const home = homedir()
  if (process.platform === 'darwin') {
    const roots = ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library/Fonts'), '/Network/Library/Fonts']
    // Downloaded macOS fonts live outside the standard Fonts folders. Visit only
    // font asset families, never the unrelated multi-gigabyte asset catalog.
    for (const container of ['/System/Library/AssetsV2', '/System/Library/Assets', '/System/Library/AssetsV2/PreinstalledAssetsV2', '/System/Library/Assets/PreinstalledAssets', '/System/Library/PreinstalledAssetsV2', '/System/Library/PreinstalledAssets']) {
      let entries
      try { entries = await readdir(container, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if ((entry.isDirectory() || entry.isSymbolicLink()) && entry.name.startsWith('com_apple_MobileAsset_Font')) roots.push(path.join(container, entry.name))
      }
    }
    return roots
  }
  if (process.platform === 'win32') return [path.join(process.env.SystemRoot || 'C:\\Windows', 'Fonts'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Microsoft/Windows/Fonts')]
  return ['/usr/share/fonts', '/usr/local/share/fonts', path.join(home, '.fonts'), path.join(home, '.local/share/fonts')]
}

async function* fontFiles(directory, seenDirectories, seenFiles) {
  let canonicalDirectory
  try { canonicalDirectory = await realpath(directory) } catch { return }
  if (seenDirectories.has(canonicalDirectory)) return
  seenDirectories.add(canonicalDirectory)
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name)
    let directoryEntry = entry.isDirectory()
    let fileEntry = entry.isFile()
    if (entry.isSymbolicLink()) {
      try { const info = await stat(filename); directoryEntry = info.isDirectory(); fileEntry = info.isFile() } catch { continue }
    }
    if (directoryEntry) yield* fontFiles(filename, seenDirectories, seenFiles)
    else if (fileEntry && fontExtensions.test(entry.name)) {
      let canonicalFile
      try { canonicalFile = await realpath(filename) } catch { continue }
      if (!seenFiles.has(canonicalFile)) { seenFiles.add(canonicalFile); yield filename }
    }
  }
}

function localizedNames(face, fullName) {
  const records = face.name?.records || {}
  const nameKeys = ['fullName', 'preferredFamily', 'fontFamily', 'compatibleFull', 'compatibleFullName', 'postscriptName']
  const aliases = new Set([face.familyName, fullName, face.postscriptName].filter(Boolean))
  for (const key of nameKeys) {
    for (const value of Object.values(records[key] || {})) {
      if (typeof value === 'string' && value.trim()) aliases.add(value.trim())
    }
  }
  const chinese = (values) => {
    if (!values) return undefined
    for (const language of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-HK']) {
      if (typeof values[language] === 'string' && values[language].trim()) return values[language].trim()
    }
    return Object.entries(values).find(([language, value]) => /^zh(?:-|$)/i.test(language) && typeof value === 'string' && value.trim())?.[1]
  }
  let localizedFullName = chinese(records.fullName)
  if (!localizedFullName) {
    const family = chinese(records.preferredFamily) || chinese(records.fontFamily) || chinese(records.compatibleFull) || chinese(records.compatibleFullName)
    const style = chinese(records.preferredSubfamily) || chinese(records.fontSubfamily)
    if (family) localizedFullName = style && !family.includes(style) ? `${family} ${style}` : family
  }
  if (localizedFullName) aliases.add(localizedFullName)
  return { localizedFullName: localizedFullName || fullName, aliases: [...aliases] }
}

function isLoopback(value = '') {
  return value === '::1' || value.startsWith('127.') || value.startsWith('::ffff:127.')
}

function isLocalRequest(request) {
  if (!isLoopback(request.socket.remoteAddress)) return false
  try {
    const host = new URL(`http://${request.headers.host}`)
    if (!['localhost', '[::1]'].includes(host.hostname) && !(isIP(host.hostname) === 4 && host.hostname.startsWith('127.'))) return false
    if (request.headers.origin) {
      const origin = new URL(request.headers.origin)
      if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== host.host) return false
    }
    return true
  } catch { return false }
}

function json(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  response.end(JSON.stringify(value))
}

/** Local-only font access. Registry IDs never expose or accept filesystem paths. */
export default function localFontsPlugin() {
  const registry = new Map()
  let cachedDescriptors
  let scanPromise
  async function scan(refresh = false) {
    if (scanPromise) return scanPromise
    if (!refresh && cachedDescriptors) return cachedDescriptors
    scanPromise = (async () => {
      const descriptors = []
      const seenDirectories = new Set()
      const seenFiles = new Set()
      for (const directory of await directories()) {
        for await (const filename of fontFiles(directory, seenDirectories, seenFiles)) {
          try {
            const info = await stat(filename)
            // Process one file at a time; retain names and paths, never parsed fonts or raw buffers.
            const bytes = await readFile(filename)
            const parsed = fontkit.create(bytes)
            const faces = parsed.fonts || [parsed]
            for (const [index, face] of faces.entries()) {
              try {
                const postscriptName = face.postscriptName || ''
                const fullName = face.fullName || postscriptName || path.basename(filename)
                const style = face.subfamilyName || 'Regular'
                const id = createHash('sha256').update(`${filename}\0${info.size}\0${info.mtimeMs}\0${index}\0${postscriptName}`).digest('hex')
                const descriptor = {
                  id, family: face.familyName || fullName, fullName, postscriptName, style,
                  weight: face['OS/2']?.usWeightClass || (/bold/i.test(style) ? 700 : 400),
                  italic: Boolean(face.italicAngle || face.head?.macStyle?.italic || /italic|oblique/i.test(style)), source: 'system',
                  ...localizedNames(face, fullName),
                }
                registry.set(id, { filename, size: info.size, mtimeMs: info.mtimeMs })
                descriptors.push(descriptor)
              } catch { /* A malformed face must not hide the other faces of a collection. */ }
            }
          } catch { /* Unreadable or unsupported OS font containers are excluded. */ }
        }
      }
      cachedDescriptors = descriptors.sort((a, b) => a.family.localeCompare(b.family) || a.fullName.localeCompare(b.fullName))
      return cachedDescriptors
    })().finally(() => { scanPromise = undefined })
    return scanPromise
  }

  function install(server) {
    server.middlewares.use(async (request, response, next) => {
      const pathname = request.url?.split('?')[0] || ''
      if (pathname !== '/api/fonts' && !pathname.startsWith('/api/fonts/')) return next()
      if (!isLocalRequest(request)) return json(response, 403, { error: '本机字体接口仅允许本机同源访问。' })
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET')
        return json(response, 405, { error: '仅支持读取字体。' })
      }
      try {
        const refresh = pathname === '/api/fonts' && new URL(request.url, 'http://localhost').searchParams.get('refresh') === '1'
        const id = pathname.slice('/api/fonts/'.length)
        if (pathname !== '/api/fonts' && !/^[a-f0-9]{64}$/.test(id)) return json(response, 404, { error: '未找到该本机字体。' })
        const descriptors = await scan(refresh)
        if (pathname === '/api/fonts') return json(response, 200, descriptors)
        const entry = registry.get(id)
        if (!entry) return json(response, 404, { error: '未找到该本机字体。' })
        const current = await stat(entry.filename)
        if (current.size !== entry.size || current.mtimeMs !== entry.mtimeMs) return json(response, 409, { error: '字体文件已变化，请重新启动阅读器以刷新字体列表。' })
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': entry.size, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
        const stream = createReadStream(entry.filename)
        stream.on('error', () => response.destroy())
        stream.pipe(response)
      } catch {
        json(response, 500, { error: '读取本机字体失败。' })
      }
    })
  }
  return { name: 'folio-local-fonts', configureServer: install, configurePreviewServer: install }
}
