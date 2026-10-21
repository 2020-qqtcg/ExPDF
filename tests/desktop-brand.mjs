import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { _electron as electron, expect } from '@playwright/test'

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('ExPDF keeps the legacy default profile and origin while exposing its new native identity across a restart', { timeout: 100_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'expdf-brand-'))
  const appData = path.join(directory, 'app-data')
  const legacyProfile = path.join(appData, 'Folio PDF')
  const entry = path.join(directory, 'brand-entry.mjs')
  await mkdir(legacyProfile, { recursive: true })
  const marker = path.join(legacyProfile, 'legacy-profile-marker.json')
  await writeFile(marker, JSON.stringify({ retained: true }))
  // Change appData before importing the real entry point, so this checks the
  // normal default-path policy without ever opening the user's real profile.
  await writeFile(entry, `import { app } from 'electron'
app.setPath('appData', ${JSON.stringify(appData)})
const setAbout = app.setAboutPanelOptions.bind(app)
app.setAboutPanelOptions = options => { globalThis.__brandAbout = options; setAbout(options) }
await import(${JSON.stringify(pathToFileURL(path.join(project, 'desktop/main.mjs')).href)})
`)
  const env = { ...process.env, FOLIO_START_HIDDEN: '1' }
  delete env.FOLIO_USER_DATA_DIR
  delete env.ELECTRON_RUN_AS_NODE
  let application
  const launch = async () => {
    application = await electron.launch({ args: [entry], cwd: project, env, timeout: 60_000 })
    const page = await application.firstWindow()
    await expect(page).toHaveURL('folio://app/index.html')
    await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.save-state')).toHaveText('已保存到本机')
    return page
  }
  try {
    let page = await launch()
    const identity = await application.evaluate(({ app, BrowserWindow, Menu }) => ({
      name: app.getName(), userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), appData: app.getPath('appData'),
      title: BrowserWindow.getAllWindows()[0].getTitle(), about: globalThis.__brandAbout,
      menuName: Menu.getApplicationMenu().items[0].label,
      menuLabels: Menu.getApplicationMenu().items[0].submenu.items.map(item => item.label),
    }))
    assert.equal(identity.name, 'ExPDF')
    assert.equal(identity.userData, legacyProfile)
    assert.equal(identity.sessionData, legacyProfile)
    assert.equal(identity.appData, appData)
    assert.match(identity.title, /ExPDF/)
    assert.equal(identity.menuName, 'ExPDF')
    assert(identity.menuLabels.includes('关于 ExPDF'))
    assert(identity.menuLabels.includes('退出 ExPDF'))
    assert.equal(identity.about.applicationName, 'ExPDF')
    assert.match(identity.about.credits, /本机 Codex CLI/)
    assert.match(identity.about.credits, /订阅/)
    await expect(page).toHaveTitle(/ · ExPDF$/)
    await page.getByRole('button', { name: '使用帮助', exact: true }).click()
    const help = page.locator('dialog[open]')
    await help.waitFor({ state: 'visible' })
    await mkdir(path.join(project, 'tmp'), { recursive: true })
    await page.screenshot({ path: path.join(project, 'tmp/expdf-help.png'), animations: 'disabled' })
    await help.getByRole('button', { name: '关闭', exact: true }).click()
    await page.getByRole('button', { name: '切换浅色外观', exact: true }).click()
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light')
    const original = await page.evaluate(async () => {
      localStorage.setItem('brand-restart-sentinel', 'legacy-origin-kept')
      const id = localStorage.getItem('folio:last-document')
      const manifest = localStorage.getItem('folio:open-documents')
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('folio-reader', 1)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      const saved = await new Promise((resolve, reject) => {
        const request = database.transaction('sessions').objectStore('sessions').get(id)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      database.close()
      return { id, manifest, name: saved.name, bytes: saved.bytes.length, annotations: saved.annotations.length }
    })
    assert(original.id)
    assert(original.bytes > 1000)
    await application.close(); application = undefined
    assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), { retained: true })
    page = await launch()
    assert.deepEqual(await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') })), { userData: legacyProfile, sessionData: legacyProfile })
    await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', 'light')
    const restored = await page.evaluate(() => ({ id: localStorage.getItem('folio:last-document'), manifest: localStorage.getItem('folio:open-documents'), sentinel: localStorage.getItem('brand-restart-sentinel'), bridge: typeof window.folioDesktop }))
    assert.equal(restored.id, original.id)
    assert.equal(restored.manifest, original.manifest)
    assert.equal(restored.sentinel, 'legacy-origin-kept')
    assert.equal(restored.bridge, 'object')
    await expect(page.getByRole('tab', { name: `切换到 PDF：${original.name}`, exact: true })).toHaveAttribute('aria-selected', 'true')
    await expect(page).toHaveTitle(/ · ExPDF$/)
  } finally {
    await application?.close().catch(() => {})
    await rm(directory, { recursive: true, force: true })
  }
})
