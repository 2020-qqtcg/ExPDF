import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { _electron as electron, expect } from '@playwright/test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from 'pdf-lib'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopUrl = 'folio://app/index.html'
const fixtureName = 'desktop-fixture.pdf'
const firstNote = '桌面批注：保留中文。'
const lastNote = '关闭前即时保存的批注。'

async function fixtureBytes() {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 3; number++) {
    const sheet = document.addPage([612, 792])
    sheet.drawText(`Native desktop paper - page ${number}`, { x: 56, y: 730, size: 22, font })
    sheet.drawText('Native desktop PDF selection stays readable.', { x: 56, y: 660, size: 18, font })
    sheet.drawText('This document is a temporary acceptance-test fixture.', { x: 56, y: 624, size: 16, font })
  }
  return Buffer.from(await document.save())
}

async function launch(userData) {
  const environment = { ...process.env, FOLIO_USER_DATA_DIR: userData, FOLIO_START_HIDDEN: '1' }
  delete environment.ELECTRON_RUN_AS_NODE
  const application = await electron.launch({ args: ['.'], cwd: projectRoot, env: environment, timeout: 60_000 })
  try {
    const page = await application.firstWindow({ timeout: 60_000 })
    await expect(page).toHaveURL(desktopUrl)
    await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible({ timeout: 30_000 })
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), userData)
    return { application, page }
  } catch (error) {
    await application.close().catch(() => {})
    throw error
  }
}

async function stubDialogs(application, input, output) {
  await application.evaluate(({ app, dialog, shell }, paths) => {
    globalThis.__folioTestDialogs = { opens: 0, saves: 0, messages: 0, external: [], recents: [] }
    dialog.showOpenDialog = async () => {
      globalThis.__folioTestDialogs.opens++
      return { canceled: !paths.input, filePaths: paths.input ? [paths.input] : [] }
    }
    dialog.showSaveDialog = async () => {
      globalThis.__folioTestDialogs.saves++
      return { canceled: !paths.output, filePath: paths.output || undefined }
    }
    dialog.showMessageBox = async () => {
      globalThis.__folioTestDialogs.messages++
      return { response: 2, checkboxChecked: false }
    }
    // Keep temporary fixture paths out of the user's macOS recent-document list.
    app.addRecentDocument = filename => { globalThis.__folioTestDialogs.recents.push(filename) }
    // External-link assertions must never open the user's browser or another app.
    shell.openExternal = async url => { globalThis.__folioTestDialogs.external.push(url) }
  }, { input, output })
}

async function showAnnotations(page) {
  if (!await page.locator('.annotations-panel').isVisible()) await page.getByRole('button', { name: '查看标注', exact: true }).click()
  await expect(page.locator('.annotations-panel')).toBeVisible()
}

async function addNote(page, content, pageNumber = 1) {
  await page.locator('.tool-list').getByRole('button', { name: '便签', exact: true }).click()
  await page.locator(`#page-${pageNumber}`).click({ position: { x: 95, y: 270 } })
  await page.getByRole('textbox', { name: '标注内容', exact: true }).fill(content)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.annotation-card').filter({ hasText: content })).toBeVisible()
}

async function nativeEdit(application, label) {
  await application.evaluate(({ BrowserWindow, Menu }, name) => {
    const item = Menu.getApplicationMenu()?.items.find(menu => menu.label === '编辑')?.submenu?.items.find(entry => entry.label === name)
    if (!item?.enabled) throw new Error(`Native edit menu unavailable: ${name}`)
    item.click(item, BrowserWindow.getAllWindows()[0], {})
  }, label)
}

async function annotationValues(filename) {
  const document = await PDFDocument.load(await readFile(filename))
  const annotations = []
  for (const page of document.getPages()) {
    const array = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray)
    for (let index = 0; array && index < array.size(); index++) {
      const annotation = array.lookup(index, PDFDict)
      const contents = annotation.lookup(PDFName.of('Contents'))
      annotations.push({ subtype: annotation.lookup(PDFName.of('Subtype'), PDFName).asString(), contents: contents instanceof PDFHexString || contents instanceof PDFString ? contents.decodeText() : '' })
    }
  }
  return { pages: document.getPageCount(), annotations }
}

async function expectSavedPdf(filename) {
  await expect.poll(async () => {
    try {
      const value = await annotationValues(filename)
      return value.pages === 3 && value.annotations.some(annotation => annotation.subtype === '/Highlight') && value.annotations.some(annotation => annotation.subtype === '/Text' && annotation.contents.includes(firstNote))
    } catch { return false }
  }, { timeout: 30_000 }).toBe(true)
}

test('built Electron opens and saves native PDFs, serves local fonts, and restores history after an immediate close', { timeout: 150_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folio-desktop-smoke-'))
  const userData = path.join(directory, 'user-data')
  const sourceDirectory = path.join(directory, 'source'), exportDirectory = path.join(directory, 'export')
  await Promise.all([mkdir(sourceDirectory), mkdir(exportDirectory)])
  const source = path.join(sourceDirectory, fixtureName), output = path.join(exportDirectory, fixtureName)
  const original = await fixtureBytes()
  await writeFile(source, original)
  let application
  try {
    let launched = await launch(userData)
    application = launched.application
    let page = launched.page
    const pageErrors = [], webRequests = []
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('request', request => { if (/^https?:/.test(request.url())) webRequests.push(request.url()) })
    await stubDialogs(application, source, output)
    await page.locator('.tab-actions').getByLabel('更多', { exact: true }).click()
    await expect(page.getByRole('menuitem', { name: '保存 PDF', exact: true })).toBeVisible()
    await page.locator('.tab-actions').getByLabel('更多', { exact: true }).click()
    await page.getByLabel('更多', { exact: true }).click()
    await page.getByRole('menuitem', { name: '打开文件', exact: true }).click()
    await expect(page.locator('#page-1 .textLayer')).toContainText('Native desktop paper - page 1')
    await expect(page.locator('#page-1 .pdf-page-placeholder')).toBeHidden()
    await showAnnotations(page)
    await page.locator('.tool-list').getByRole('button', { name: '高亮', exact: true }).click()
    const text = page.locator('#page-1 .textLayer span').filter({ hasText: 'Native desktop PDF selection stays readable.' }).first()
    const bounds = await text.boundingBox()
    assert(bounds)
    await page.mouse.move(bounds.x + 2, bounds.y + bounds.height / 2)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width - 2, bounds.y + bounds.height / 2, { steps: 10 })
    await page.mouse.up()
    await expect(page.locator('.pdf-mark-highlight')).toHaveCount(1)
    await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
    await addNote(page, firstNote)
    await page.locator('#page-1').click({ position: { x: 450, y: 400 } })
    await nativeEdit(application, '撤销')
    await expect(page.locator('.annotation-card')).toHaveCount(1)
    await nativeEdit(application, '重做')
    await expect(page.locator('.annotation-card')).toHaveCount(2)
    await page.locator('.annotation-card').filter({ hasText: firstNote }).click()
    const editor = page.getByRole('textbox', { name: '标注内容', exact: true })
    await editor.evaluate(element => { element.focus(); element.setSelectionRange(element.value.length, element.value.length) })
    await editor.pressSequentially('X')
    await expect(editor).toHaveValue(`${firstNote}X`)
    await nativeEdit(application, '撤销')
    await expect(editor).toHaveValue(firstNote)
    await expect(page.locator('.annotation-card')).toHaveCount(2)
    await nativeEdit(application, '重做')
    await expect(editor).toHaveValue(`${firstNote}X`)
    await page.getByRole('button', { name: '取消', exact: true }).click()
    await expect(page.locator('.annotation-card').filter({ hasText: firstNote })).toBeVisible()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expectSavedPdf(source)
    assert.notDeepEqual(await readFile(source), original)
    await page.getByLabel('更多', { exact: true }).click()
    await page.getByRole('menuitem', { name: '另存为 PDF', exact: true }).click()
    await expectSavedPdf(output)
    const dialogs = await application.evaluate(() => globalThis.__folioTestDialogs)
    assert.equal(dialogs.opens, 1)
    assert.equal(dialogs.saves, 1)
    assert.equal(dialogs.messages, 0)

    const fonts = await page.evaluate(async () => {
      const response = await fetch('/api/fonts')
      if (!response.ok) throw new Error(`Local font API returned ${response.status}`)
      const list = await response.json()
      const selected = list.find(font => font.postscriptName === 'ArialMT') ?? list[0]
      if (!selected) throw new Error('No local fonts available')
      const file = await fetch(`/api/fonts/${encodeURIComponent(selected.id)}`)
      return { count: list.length, source: selected.source, status: file.status, bytes: (await file.arrayBuffer()).byteLength }
    })
    assert(fonts.count > 0)
    assert.equal(fonts.source, 'system')
    assert.equal(fonts.status, 200)
    assert(fonts.bytes > 1000)
    // Listing CLI capabilities is read-only and never starts a model response.
    const models = await page.evaluate(async () => {
      const response = await fetch('/api/codex/models')
      return { status: response.status, value: await response.json() }
    })
    if (models.status === 200) {
      assert(models.value.models.length > 0)
      assert(models.value.models.some(model => model.id === models.value.defaultModel))
    } else assert.equal(typeof models.value.error, 'string')
    assert.deepEqual(webRequests, [])
    assert.deepEqual(pageErrors, [])

    const pageInput = page.getByRole('textbox', { name: '当前页码', exact: true })
    await pageInput.fill('2'); await pageInput.press('Enter')
    await expect(pageInput).toHaveValue('2')
    await expect(page.locator('#page-2 .textLayer')).toContainText('Native desktop paper - page 2')
    // Fit-width pages are taller: wait until smooth navigation actually reaches page two.
    await expect(page.locator('#page-2')).toBeInViewport({ ratio: 0.75 })
    await addNote(page, lastNote, 2)
    await expect(pageInput).toHaveValue('2')
    // Intentionally close before the normal save debounce: the close handshake must flush this note.
    await application.close()
    application = undefined
    launched = await launch(userData)
    application = launched.application
    page = launched.page
    await stubDialogs(application, '', '')
    await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue('2')
    await showAnnotations(page)
    await expect(page.locator('.annotation-card')).toHaveCount(3)
    await expect(page.locator('.annotation-card').filter({ hasText: lastNote })).toBeVisible()
    await expect(page.locator('#page-2 .pdf-page-placeholder')).toBeHidden()
    await page.getByRole('button', { name: '最近阅读', exact: true }).click()
    const row = page.getByRole('button', { name: `打开历史 PDF：${fixtureName}`, exact: true })
    await expect(row).toHaveCount(1)
    await expect(row).toContainText('当前文件')
    await row.click()
    assert.equal((await application.evaluate(() => globalThis.__folioTestDialogs)).opens, 0)
    await mkdir(path.join(projectRoot, 'tmp'), { recursive: true })
    await page.screenshot({ path: path.join(projectRoot, 'tmp/desktop-reader.png') })
    console.log(`Desktop PDF smoke: ${fonts.count} fonts; Codex catalog status ${models.status}; native save, Save As and restart persistence passed.`)
  } finally {
    if (application) await application.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test('Electron isolates the renderer and rejects foreign IPC, protocol traversal, and external navigation inside the reader', { timeout: 100_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folio-desktop-security-'))
  let application
  try {
    const launched = await launch(path.join(directory, 'user-data'))
    application = launched.application
    const page = launched.page
    await stubDialogs(application, path.join(directory, 'never-open.pdf'), path.join(directory, 'never-save.pdf'))
    const preferences = await application.evaluate(({ BrowserWindow }) => {
      const value = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      return { sandbox: value.sandbox, contextIsolation: value.contextIsolation, nodeIntegration: value.nodeIntegration }
    })
    assert.deepEqual(preferences, { sandbox: true, contextIsolation: true, nodeIntegration: false })
    const exposed = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, bridge: typeof window.folioDesktop }))
    assert.deepEqual(exposed, { require: 'undefined', process: 'undefined', bridge: 'object' })
    const rejected = await application.evaluate(async ({ BrowserWindow }, pdfBytes) => {
      const trusted = BrowserWindow.getAllWindows()[0]
      const attacker = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: trusted.webContents.getLastWebPreferences().preload } })
      try {
        await attacker.loadURL('data:text/html,<h1>Untrusted origin test fixture</h1>')
        return await attacker.webContents.executeJavaScript(`(async () => {
          const bridge = window.folioDesktop;
          if (!bridge) return [true, true, true];
          const denied = promise => promise.then(() => false, () => true);
          return Promise.all([denied(bridge.openPdf()), denied(bridge.openPdfs()), denied(bridge.savePdf({ bytes: new Uint8Array(${JSON.stringify(pdfBytes)}), suggestedName: 'never-save.pdf', saveAs: true }))]);
        })()`)
      } finally { attacker.destroy() }
    }, [...await fixtureBytes()])
    assert.deepEqual(rejected, [true, true, true])
    assert.deepEqual(await application.evaluate(() => ({ opens: globalThis.__folioTestDialogs.opens, saves: globalThis.__folioTestDialogs.saves })), { opens: 0, saves: 0 })
    await assert.rejects(stat(path.join(directory, 'never-save.pdf')))

    const traversal = await page.evaluate(async () => Promise.all([
      'folio://app/%2e%2e%2fpackage.json', 'folio://app/%2e%2e%5cpackage.json', 'folio://app/%00index.html',
    ].map(async url => {
      try { const response = await fetch(url); return { status: response.status, body: await response.text() } }
      catch { return { status: 0, body: '' } }
    })))
    for (const result of traversal) {
      assert([0, 400, 403, 404].includes(result.status), `Unexpected traversal status ${result.status}`)
      assert(!result.body.includes('folio-pdf-reader'))
    }
    await page.evaluate(() => {
      const link = document.createElement('a')
      link.id = 'desktop-external-fixture'; link.href = 'https://example.invalid/folio-desktop-test'; link.target = '_blank'
      link.textContent = 'External navigation acceptance fixture'
      link.style.cssText = 'position:fixed;top:8px;left:550px;z-index:9999;padding:8px;background:white;color:black'
      document.body.append(link)
    })
    await page.locator('#desktop-external-fixture').click()
    await expect.poll(() => application.evaluate(() => globalThis.__folioTestDialogs.external)).toContain('https://example.invalid/folio-desktop-test')
    const navigationUrl = await page.evaluate(() => new Promise(resolve => {
      window.location.href = 'http://127.0.0.1:49159/forbidden'
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(window.location.href)))
    }))
    // A canceled Electron will-navigate can leave CDP's provisional URL empty;
    // check both actual document and native webContents rather than that pending loader.
    assert.equal(navigationUrl, desktopUrl)
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()), desktopUrl)
    const readerVisible = await page.evaluate(() => {
      const text = document.querySelector('#page-1 .textLayer span')
      const bounds = text?.getBoundingClientRect()
      return !!text?.textContent && !!bounds?.width && !!bounds?.height
    })
    assert.equal(readerVisible, true)
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    await page.evaluate(() => window.open('file:///tmp/folio-desktop-never-open.pdf'))
    assert((await application.evaluate(() => globalThis.__folioTestDialogs.external)).every(url => /^https?:/.test(url)))
    assert.equal(await page.evaluate(() => window.location.href), desktopUrl)
    console.log('Desktop security smoke: sandbox, foreign sender rejection, traversal rejection and external navigation passed.')
  } finally {
    if (application) await application.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})

test('Electron opens multiple PDFs with the native picker, restores both tabs, and sends closeTab without closing its window', { timeout: 100_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'folio-desktop-tabs-'))
  const userData = path.join(directory, 'profile')
  const firstPath = path.join(directory, '批量一.pdf'), secondPath = path.join(directory, '批量二.pdf')
  const firstBytes = await fixtureBytes()
  const secondDocument = await PDFDocument.load(firstBytes)
  secondDocument.setTitle('Second independent PDF fixture')
  const secondBytes = Buffer.from(await secondDocument.save())
  await Promise.all([writeFile(firstPath, firstBytes), writeFile(secondPath, secondBytes)])
  const invalidPath = path.join(directory, 'invalid.pdf')
  await writeFile(invalidPath, 'This is not a PDF.')
  let application
  try {
    let launched = await launch(userData)
    application = launched.application
    let page = launched.page
    await application.evaluate(({ app, dialog }, inputs) => {
      globalThis.__multiOpenTest = { paths: inputs, canceled: false, dialogs: [], recents: [] }
      dialog.showOpenDialog = async (_window, options) => {
        globalThis.__multiOpenTest.dialogs.push(options)
        return { canceled: globalThis.__multiOpenTest.canceled, filePaths: [...globalThis.__multiOpenTest.paths] }
      }
      app.addRecentDocument = value => globalThis.__multiOpenTest.recents.push(value)
    }, [firstPath, secondPath])
    const readMultiple = () => page.evaluate(async () => (await window.folioDesktop.openPdfs()).map(pdf => ({ name: pdf.name, bytes: [...pdf.bytes], sourceId: pdf.sourceId })))
    const multiple = await readMultiple()
    assert.deepEqual(multiple.map(pdf => pdf.name), ['批量一.pdf', '批量二.pdf'])
    assert.deepEqual(Buffer.from(multiple[0].bytes), firstBytes)
    assert.deepEqual(Buffer.from(multiple[1].bytes), secondBytes)
    assert(multiple.every(pdf => /^[a-f0-9]{32}$/.test(pdf.sourceId)))
    assert.notEqual(multiple[0].sourceId, multiple[1].sourceId)
    const legacy = await page.evaluate(async () => { const pdf = await window.folioDesktop.openPdf(); return { name: pdf.name, sourceId: pdf.sourceId } })
    assert.deepEqual(legacy, { name: '批量一.pdf', sourceId: multiple[0].sourceId })
    const options = await application.evaluate(() => globalThis.__multiOpenTest.dialogs)
    assert.deepEqual(options[0].properties, ['openFile', 'multiSelections'])
    assert.deepEqual(options[1].properties, ['openFile'])
    assert.deepEqual(options[0].filters, [{ name: 'PDF 文档', extensions: ['pdf'] }])
    await application.evaluate(() => { globalThis.__multiOpenTest.canceled = true })
    assert.deepEqual(await readMultiple(), [])
    assert.equal(await page.evaluate(() => window.folioDesktop.openPdf()), null)
    await application.evaluate((_electron, filename) => { globalThis.__multiOpenTest.canceled = false; globalThis.__multiOpenTest.paths = [filename] }, invalidPath)
    assert.equal(await page.evaluate(() => window.folioDesktop.openPdfs().then(() => false, () => true)), true, 'Multi-open must retain native PDF header validation')
    await application.evaluate((_electron, inputs) => { globalThis.__multiOpenTest.paths = inputs }, [firstPath, secondPath])
    await application.evaluate(({ Menu, BrowserWindow }) => {
      const file = Menu.getApplicationMenu().items.find(item => item.label === '文件')
      const open = file.submenu.items.find(item => item.label === '打开 PDF…')
      open.click(open, BrowserWindow.getAllWindows()[0])
    })
    const tab = name => page.getByRole('tab', { name: `切换到 PDF：${name}`, exact: true })
    await expect(tab('批量一.pdf')).toBeVisible()
    await expect(tab('批量二.pdf')).toHaveAttribute('aria-selected', 'true')
    // Close before depending on a normal save debounce; the window handshake
    // must preserve every open PDF as well as the active tab.
    await application.close(); application = undefined
    launched = await launch(userData)
    application = launched.application; page = launched.page
    await expect(tab('批量一.pdf')).toBeVisible()
    await expect(tab('批量二.pdf')).toHaveAttribute('aria-selected', 'true')
    await page.evaluate(() => { window.__tabCommands = []; window.folioDesktop.onCommand(command => window.__tabCommands.push(command)) })
    const menu = await application.evaluate(({ Menu, BrowserWindow }) => {
      const file = Menu.getApplicationMenu().items.find(item => item.label === '文件')
      const closeTab = file.submenu.items.find(item => item.label === '关闭标签页')
      const closeWindow = file.submenu.items.find(item => item.label === '关闭窗口')
      const snapshot = { tab: closeTab.accelerator, window: closeWindow.accelerator, windowRole: closeWindow.role }
      closeTab.click(closeTab, BrowserWindow.getAllWindows()[0])
      return snapshot
    })
    assert.deepEqual(menu, { tab: 'CmdOrCtrl+W', window: 'CmdOrCtrl+Shift+W', windowRole: 'close' })
    await expect.poll(() => page.evaluate(() => window.__tabCommands)).toContain('closeTab')
    await expect(tab('批量二.pdf')).toHaveCount(0)
    await expect(tab('批量一.pdf')).toHaveAttribute('aria-selected', 'true')
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    assert.equal(await page.url(), desktopUrl)
  } finally {
    await application?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
