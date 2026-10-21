import { clickFileAction, selectTool, fileAction, closeFileMenu } from './helpers/reader'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'

type Bounds = { x: number; y: number; width: number; height: number }

async function bounds(locator: Locator): Promise<Bounds> {
  const value = await locator.boundingBox()
  expect(value).not.toBeNull()
  return value!
}

test('uses the persistent markup toolbar and real color menus, remembers the chosen markup, and keeps file actions in the title bar', async ({ page }) => {
  await stubCodex(page)
  const document = await PDFDocument.create()
  const sheet = document.addPage([612, 792])
  const font = await document.embedFont(StandardFonts.Helvetica)
  const lines = ['Blue underline selected from the real menu.', 'Green strikeout selected from the same menu.']
  for (const [index, text] of lines.entries()) sheet.drawText(text, { x: 56, y: 630 - index * 55, size: 18, font })
  await page.goto('/')
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  // Multi-document opening preserves the demo tab. Start this single-document
  // toolbar lifecycle from an empty workspace so closing it still tests empty.
  await page.getByRole('button', { name: '关闭当前 PDF', exact: true }).click()
  await expect(page.locator('.welcome-empty')).toBeVisible()
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'updf-tools.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) })
  await expect(page.locator('#page-1 .textLayer')).toContainText(lines[0])
  await waitForDocument(page)

  const trigger = page.getByRole('button', { name: '高亮与划线选项', exact: true })
  const menu = page.getByRole('menu', { name: '高亮与划线', exact: true })
  const dragText = async (text: string) => {
    const span = page.locator('#page-1 .textLayer span').filter({ hasText: text }).first()
    const box = await bounds(span)
    await page.mouse.move(box.x + 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 12 })
    await page.mouse.up()
  }
  for (const [index, choice] of [
    { label: '下划线', color: '蓝色', value: '#82b6e3', kind: 'underline' },
    { label: '删除线', color: '绿色', value: '#8bcbb2', kind: 'strikeout' },
  ].entries()) {
    await trigger.click()
    await expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await expect(menu).toBeVisible()
    await menu.getByRole('button', { name: choice.color, exact: true }).click()
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('button', { name: choice.color, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await menu.getByRole('menuitemradio', { name: new RegExp(`^${choice.label}`) }).click()
    await expect(menu).toHaveCount(0)
    await expect(page.locator('.tool-list').getByRole('button', { name: choice.label, exact: true })).toHaveAttribute('aria-pressed', 'true')
    await dragText(lines[index])
    await expect(page.locator(`#page-1 .pdf-mark-${choice.kind}`)).toHaveCount(1)
    await expect(page.locator(`#page-1 .pdf-mark-${choice.kind} line`)).toHaveAttribute('stroke', choice.value)
    await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  }
  await page.getByRole('button', { name: '选择工具选项', exact: true }).click()
  await page.getByRole('menu', { name: '选择工具', exact: true }).getByRole('menuitemradio', { name: /^拖动阅读/ }).click()
  await expect(page.locator('.tool-list').getByRole('button', { name: '拖动阅读', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.tool-list').getByRole('button', { name: '删除线', exact: true })).toBeVisible()
  await expect(page.locator('.tool-list')).toBeVisible()
  await expect(page.getByRole('button', { name: '关闭注释工具栏', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '工具', exact: true })).toHaveCount(0)
  await selectTool(page, '高亮')
  await expect(page.locator('.tool-list').getByRole('button', { name: '高亮', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await trigger.click()
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(2)
  await clickFileAction(page, '撤销')
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(1)
  await clickFileAction(page, '重做')
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(2)
  await expect(await fileAction(page, '导出 PDF')).toBeEnabled()
  await expect(page.locator('.tab-actions .more-menu')).toHaveCount(1)
  await expect(page.getByRole('menuitem', { name: /Codex/ })).toHaveCount(0)
  await closeFileMenu(page)
  await page.getByRole('button', { name: '关闭当前 PDF', exact: true }).click()
  await expect(page.locator('.pdf-page')).toHaveCount(0)
  await page.getByRole('button', { name: '最近阅读', exact: true }).click()
  await page.getByRole('button', { name: '打开历史 PDF：updf-tools.pdf', exact: true }).click()
  await waitForDocument(page)
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(2)
})

async function stubCodex(page: Page) {
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: {
    defaultModel: 'layout-model',
    models: [{ id: 'layout-model', name: 'Layout test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }],
  } }))
  // Layout checks never submit a question to the user's installed CLI.
  await page.route('**/api/codex/ask', route => route.abort())
}

async function waitForDocument(page: Page) {
  await expect(page.locator('#page-1 .pdf-page-placeholder')).toBeHidden()
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  await page.evaluate(() => document.fonts.ready)
  await expect.poll(() => page.locator('#page-1 canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement
    const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
    let ink = 0
    for (let i = 0; pixels && i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180) ink++
    return ink
  })).toBeGreaterThan(1000)
}

async function assertNoOverflow(page: Page, width: number) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  for (const selector of ['.document-tabs', '.reader-layout', '.navigation-rail', '.reader-area', '.toolbar', '.floating-controls']) {
    const box = await bounds(page.locator(selector))
    expect(box.x, `${selector} left`).toBeGreaterThanOrEqual(-1)
    expect(box.x + box.width, `${selector} right`).toBeLessThanOrEqual(width + 1)
  }
  const reader = await bounds(page.locator('.reader-area'))
  const tools = await bounds(page.locator('.annotation-tools'))
  expect(tools.x).toBeGreaterThanOrEqual(reader.x - 1)
  expect(tools.x + tools.width).toBeLessThanOrEqual(reader.x + reader.width + 1)
  await expect(page.locator('.toolbar-side, .toolbar-end, .codex-tab')).toHaveCount(0)
}

async function assertPanelFits(page: Page, selector: string, width: number, height: number) {
  const box = await bounds(page.locator(selector))
  expect(box.x).toBeGreaterThanOrEqual(51)
  expect(box.y).toBeCloseTo(40, 0)
  expect(box.x + box.width).toBeLessThanOrEqual(width + 1)
  expect(box.y + box.height).toBeLessThanOrEqual(height + 1)
}

for (const viewport of [
  { width: 1920, height: 998 },
  { width: 1512, height: 1100 },
  { width: 980, height: 760 },
  { width: 390, height: 844 },
]) {
  test(`keeps the floating UPDF workspace and real panel navigation usable at ${viewport.width}×${viewport.height}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await stubCodex(page)
    await page.setViewportSize(viewport)
    await page.goto('/')
    await waitForDocument(page)

    const tabs = await bounds(page.locator('.document-tabs'))
    const layout = await bounds(page.locator('.reader-layout'))
    const rail = await bounds(page.locator('.navigation-rail'))
    const area = await bounds(page.locator('.reader-area'))
    const scroll = await bounds(page.locator('.document-scroll'))
    const toolbar = await bounds(page.locator('.toolbar'))
    expect(tabs.y).toBeCloseTo(0, 0)
    expect(tabs.height).toBeCloseTo(40, 0)
    expect(layout.y).toBeCloseTo(tabs.y + tabs.height, 0)
    const railMargins = await page.locator('.navigation-rail').evaluate(element => {
      const style = getComputedStyle(element)
      return { left: parseFloat(style.marginLeft), right: parseFloat(style.marginRight) }
    })
    expect(rail.width).toBeCloseTo(48, 0)
    expect(railMargins.left).toBeCloseTo(4, 0)
    expect(rail.width + railMargins.left + railMargins.right).toBeCloseTo(52, 0)
    expect(rail.x - layout.x).toBeCloseTo(4, 0)
    expect(area.y).toBeCloseTo(layout.y, 0)
    expect(scroll.y).toBeCloseTo(area.y, 0)
    expect(scroll.height).toBeCloseTo(area.height, 0)
    expect(toolbar.y).toBeGreaterThan(area.y)
    expect(toolbar.height).toBeLessThanOrEqual(60)
    expect(toolbar.x).toBeGreaterThanOrEqual(area.x)
    expect(toolbar.x + toolbar.width).toBeLessThanOrEqual(area.x + area.width + 1)
    expect(await page.locator('.toolbar').evaluate(element => !!element.closest('.reader-area'))).toBe(true)
    await expect(page.locator('.annotations-panel, .codex-panel')).toHaveCount(0)
    const assistant = page.getByRole('button', { name: 'Codex AI', exact: true })
    await expect(assistant).toHaveCount(1)
    await expect(page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true })).toHaveCount(1)
    await expect(assistant).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('tablist', { name: '文档导航' })).toHaveCount(0)
    await expect.poll(() => page.locator('.document-scroll').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
    await assertNoOverflow(page, viewport.width)

    const thumbnails = page.getByRole('button', { name: '页面缩略图', exact: true })
    const initiallyOpen = await page.locator('.pages-panel').isVisible()
    await page.getByRole('button', { name: '文档目录', exact: true }).click()
    await expect(page.locator('.pages-panel').getByRole('heading', { name: '目录', exact: true })).toBeVisible()
    await assertPanelFits(page, '.pages-panel', viewport.width, viewport.height)
    const panel = await bounds(page.locator('.pages-panel'))
    const panelMargins = await page.locator('.pages-panel').evaluate(element => {
      const style = getComputedStyle(element)
      return { left: parseFloat(style.marginLeft), right: parseFloat(style.marginRight) }
    })
    expect(panel.width).toBeCloseTo(200, 0)
    expect(panelMargins.right).toBeCloseTo(4, 0)
    expect(panel.width + panelMargins.left + panelMargins.right).toBeCloseTo(204, 0)
    await page.getByRole('button', { name: '页面书签', exact: true }).click()
    await expect(page.locator('.pages-panel').getByRole('heading', { name: '书签', exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: '页面书签', exact: true })).toHaveClass(/\bactive\b/)
    await page.getByRole('button', { name: '页面书签', exact: true }).click()
    await expect(page.locator('.pages-panel')).toHaveCount(0)

    await page.getByRole('button', { name: '查看标注', exact: true }).click()
    await expect(page.locator('.annotations-panel').getByRole('heading', { name: /^标注/ })).toBeVisible()
    await assertPanelFits(page, '.annotations-panel', viewport.width, viewport.height)
    await page.getByRole('button', { name: '关闭标注面板', exact: true }).click()
    await expect(page.locator('.annotations-panel')).toHaveCount(0)
    await assistant.click()
    await expect(page.getByRole('combobox', { name: 'Codex 模型', exact: true })).toContainText('Layout test model')
    await expect(assistant).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('combobox', { name: '思考深度', exact: true })).toBeInViewport({ ratio: 1 })
    await assertPanelFits(page, '.codex-panel', viewport.width, viewport.height)
    if (viewport.width === 1512) {
      await assistant.click()
      await expect(page.locator('.codex-panel, .annotations-panel')).toHaveCount(0)
      await expect(assistant).toHaveAttribute('aria-pressed', 'false')
      await expect(page.locator('.annotation-tools')).toBeVisible()
      await assistant.click()
      await expect(page.getByRole('combobox', { name: 'Codex 模型', exact: true })).toContainText('Layout test model')
      await thumbnails.click()
      await expect(page.locator('.pages-panel')).toBeVisible()
      await assertNoOverflow(page, viewport.width)
      await waitForDocument(page)
      await mkdir('tmp', { recursive: true })
      await page.screenshot({ path: 'tmp/codex-layout-desktop.png' })
      await thumbnails.click()
    } else if (viewport.width === 980) {
      await assertNoOverflow(page, viewport.width)
      await page.getByRole('button', { name: '高亮与划线选项', exact: true }).click()
      await expect(page.getByRole('menu', { name: '高亮与划线', exact: true })).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('button', { name: '蓝色', exact: true })).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')
    } else if (viewport.width === 390) {
      await mkdir('tmp', { recursive: true })
      await page.screenshot({ path: 'tmp/codex-layout-mobile.png' })
    }
    await page.getByRole('button', { name: '关闭 Codex 侧栏', exact: true }).click()

    if (viewport.width === 390) {
      await expect(page.locator('.tool-list')).toBeVisible()
      await expect(page.getByRole('button', { name: '关闭注释工具栏', exact: true })).toHaveCount(0)
      await selectTool(page, '选择文本')
      await page.getByRole('button', { name: '高亮与划线选项', exact: true }).click()
      await expect(page.getByRole('menu', { name: '高亮与划线', exact: true })).toBeInViewport({ ratio: 1 })
      await expect(page.getByRole('button', { name: '蓝色', exact: true })).toBeInViewport({ ratio: 1 })
      await page.keyboard.press('Escape')
    }

    if (initiallyOpen) {
      await thumbnails.click()
      await expect(page.locator('.thumbnail-canvas').first()).toBeVisible()
      await expect.poll(() => page.locator('.thumbnail-canvas').first().evaluate(element => {
        const canvas = element as HTMLCanvasElement
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        let ink = 0
        for (let i = 0; pixels && i < pixels.length; i += 4) if (pixels[i + 3] && pixels[i] < 180 && pixels[i + 1] < 180 && pixels[i + 2] < 180) ink++
        return ink
      })).toBeGreaterThan(40)
    }
    await assertNoOverflow(page, viewport.width)
    await waitForDocument(page)
    await mkdir('tmp', { recursive: true })
    await page.screenshot({ path: `tmp/updf-layout-${viewport.width}x${viewport.height}.png` })
    expect(errors).toEqual([])
  })
}
