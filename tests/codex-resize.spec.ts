import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { useFixedZoom } from './helpers/reader'

const WIDTH_KEY = 'folio:codex-panel-width'
const panelFor = (page: Page) => page.getByRole('complementary', { name: 'Codex 问答', exact: true })
const separatorFor = (page: Page) => page.getByRole('separator', { name: '调整 Codex 侧栏宽度', exact: true })
type Bounds = { x: number; y: number; width: number; height: number }

async function bounds(locator: Locator): Promise<Bounds> {
  const result = await locator.boundingBox()
  expect(result).not.toBeNull()
  return result!
}

async function openAssistant(page: Page) {
  if (!await panelFor(page).isVisible()) await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  await expect(panelFor(page)).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Codex 模型', exact: true })).toContainText('Resize test model')
  await expect(separatorFor(page)).toHaveAttribute('aria-orientation', 'vertical')
}

async function openFixture(page: Page) {
  const questions: string[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: {
    defaultModel: 'resize-test',
    models: [{ id: 'resize-test', name: 'Resize test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }],
  } }))
  // Resizing must never send paper text to the installed model.
  await page.route('**/api/codex/ask', route => {
    questions.push(route.request().postData() ?? '')
    return route.fulfill({ status: 500, json: { error: 'Unexpected model request while resizing' } })
  })
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 3; number++) {
    const sheet = document.addPage([612, 792])
    sheet.drawText(`Resize acceptance paper - page ${number}`, { x: 52, y: 728, size: 18, font })
    sheet.drawText(`Reading anchor on page ${number}`, { x: 52, y: 360, size: 18, font })
  }
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1512, height: 1100 })
  await page.goto('/')
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'codex-resize.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) })
  await expect(page.locator('#page-1 .textLayer')).toContainText('Resize acceptance paper')
  await openAssistant(page)
  return questions
}

async function expectWidth(page: Page, value: number) {
  await expect.poll(async () => Math.abs((await bounds(panelFor(page))).width - value)).toBeLessThan(1)
  await expect.poll(async () => Number(await separatorFor(page).getAttribute('aria-valuenow'))).toBeCloseTo(value, 0)
}

async function dragWidth(page: Page, value: number, commit = true) {
  const handle = await bounds(separatorFor(page))
  const current = (await bounds(panelFor(page))).width
  const x = handle.x + handle.width / 2
  const y = handle.y + handle.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + current - value, y, { steps: 16 })
  await expectWidth(page, value)
  if (commit) await page.mouse.up()
}

async function savedWidth(page: Page) {
  return page.evaluate(key => localStorage.getItem(key), WIDTH_KEY)
}

async function waitForResizeBounds(page: Page) {
  // The viewport changes before ResizeObserver has measured the new available space.
  await expect.poll(async () => {
    const layout = await bounds(page.locator('.reader-layout'))
    const reader = await bounds(page.locator('.reader-area'))
    const maximum = Math.floor(page.viewportSize()!.width <= 900 ? layout.width - 56 : layout.x + layout.width - reader.x - 4 - 360)
    return Number(await separatorFor(page).getAttribute('aria-valuemax')) - maximum
  }).toBe(0)
  return Number(await separatorFor(page).getAttribute('aria-valuemax'))
}

async function expectUsableWorkspace(page: Page) {
  const width = page.viewportSize()!.width
  const panel = await bounds(panelFor(page))
  expect(panel.x).toBeGreaterThanOrEqual(51)
  expect(panel.x + panel.width).toBeLessThanOrEqual(width + 1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width)
  const reader = await bounds(page.locator('.reader-area'))
  expect(reader.width).toBeGreaterThan(0)
  const tools = await bounds(page.locator('.annotation-tools'))
  expect(tools.x).toBeGreaterThanOrEqual(reader.x - 1)
  expect(tools.x + tools.width).toBeLessThanOrEqual(reader.x + reader.width + 1)
  await expect(page.locator('.toolbar-side, .toolbar-end, .codex-tab')).toHaveCount(0)
}

test('resizes in both pointer directions without losing the reading anchor and remembers the width after closing and reloading', async ({ page }) => {
  const questions = await openFixture(page)
  const input = page.getByRole('textbox', { name: '当前页码', exact: true })
  await input.fill('2')
  await input.press('Enter')
  await expect(input).toHaveValue('2')
  const anchor = page.locator('#page-2 .textLayer span').filter({ hasText: 'Reading anchor on page 2' })
  await expect(anchor).toBeVisible()
  await anchor.evaluate(target => {
    const reader = document.querySelector('.document-scroll')!
    const text = target.getBoundingClientRect(), viewport = reader.getBoundingClientRect()
    reader.scrollTop += text.top + text.height / 2 - viewport.top - viewport.height / 3
  })
  const initialPanel = (await bounds(panelFor(page))).width
  const initialReader = await bounds(page.locator('.reader-area'))
  const initialAnchor = await bounds(anchor)
  const anchorY = initialAnchor.y + initialAnchor.height / 2
  for (const target of [initialPanel + 180, initialPanel + 100]) {
    await dragWidth(page, target)
    await expect.poll(() => savedWidth(page)).toBe(String(target))
    await expect(input).toHaveValue('2')
    await expect.poll(async () => {
      const current = await bounds(anchor)
      return Math.abs(current.y + current.height / 2 - anchorY)
    }).toBeLessThan(8)
    const reader = await bounds(page.locator('.reader-area'))
    expect(reader.x).toBeCloseTo(initialReader.x, 0)
    expect(reader.width + target).toBeCloseTo(initialReader.width + initialPanel, 0)
    await expectUsableWorkspace(page)
  }
  await useFixedZoom(page, '2')
  await expect.poll(async () => (await bounds(page.locator('#page-2'))).width).toBeCloseTo(1224, 0)
  const readingPoint = (horizontalOffset?: number) => page.evaluate(offset => {
    const reader = document.querySelector('.document-scroll')!
    const viewport = reader.getBoundingClientRect(), sheet = document.getElementById('page-2')!.getBoundingClientRect()
    const viewportX = Math.min(offset ?? reader.clientWidth / 2, reader.clientWidth / 2)
    return {
      x: (viewport.left + viewportX - sheet.left) / sheet.width,
      y: (viewport.top + reader.clientHeight / 3 - sheet.top) / sheet.height,
      viewportX,
    }
  }, horizontalOffset)
  const fixedPoint = await readingPoint()
  let horizontalOffset = fixedPoint.viewportX
  for (const target of [initialPanel + 160, initialPanel + 100]) {
    await dragWidth(page, target)
    // Keep the original reading point at its existing screen position; move it
    // inward only when that position would lie beyond the narrowed reader's centre.
    await expect.poll(async () => {
      const current = await readingPoint(horizontalOffset)
      return Math.hypot(current.x - fixedPoint.x, current.y - fixedPoint.y)
    }).toBeLessThan(0.005)
    horizontalOffset = (await readingPoint(horizontalOffset)).viewportX
    await expect(input).toHaveValue('2')
  }
  await expect(page.locator('#page-2 .pdf-page-placeholder')).toBeHidden()
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/codex-resize-desktop.png' })
  const finalWidth = initialPanel + 100
  await page.getByRole('button', { name: '关闭 Codex 侧栏', exact: true }).click()
  await expect(panelFor(page)).toHaveCount(0)
  await openAssistant(page)
  await expectWidth(page, finalWidth)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(input).toHaveValue('2')
  await openAssistant(page)
  await expectWidth(page, finalWidth)
  expect(questions).toEqual([])
})

test('supports keyboard increments and boundaries, cancels a pending drag, and resets the saved preference with a double click', async ({ page }) => {
  const questions = await openFixture(page)
  const handle = separatorFor(page)
  const initial = (await bounds(panelFor(page))).width
  const minimum = Number(await handle.getAttribute('aria-valuemin'))
  const maximum = Number(await handle.getAttribute('aria-valuemax'))
  await handle.focus()
  for (const [key, value] of [['ArrowLeft', initial + 10], ['ArrowRight', initial], ['Shift+ArrowLeft', initial + 40], ['Shift+ArrowRight', initial]] as const) {
    await handle.press(key)
    await expectWidth(page, value)
  }
  await handle.press('Home')
  await expectWidth(page, minimum)
  await handle.press('End')
  await expectWidth(page, maximum)
  expect((await bounds(page.locator('.reader-area'))).width).toBeGreaterThanOrEqual(359)
  await expectUsableWorkspace(page)
  await expect.poll(() => savedWidth(page)).toBe(String(maximum))

  await dragWidth(page, maximum - 100, false)
  // Only a completed drag may replace the saved preference.
  expect(await savedWidth(page)).toBe(String(maximum))
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expectWidth(page, maximum)
  expect(await savedWidth(page)).toBe(String(maximum))

  const edge = await bounds(handle)
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  await page.mouse.move(2, edge.y + edge.height / 2, { steps: 16 })
  await expectWidth(page, maximum)
  await page.mouse.move(page.viewportSize()!.width - 2, edge.y + edge.height / 2, { steps: 16 })
  await expectWidth(page, minimum)
  await page.mouse.up()
  await expect.poll(() => savedWidth(page)).toBe(String(minimum))
  await handle.dblclick()
  await expectWidth(page, initial)
  await expect.poll(() => savedWidth(page)).toBeNull()
  expect(questions).toEqual([])
})

test('clamps the visible panel on smaller windows without overwriting the desktop preference and permits an intentional narrow-screen resize', async ({ page }) => {
  const questions = await openFixture(page)
  const preferred = 620
  await dragWidth(page, preferred)
  await expect.poll(() => savedWidth(page)).toBe(String(preferred))
  for (const width of [980, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(panelFor(page)).toBeVisible()
    const handle = separatorFor(page)
    const maximum = await waitForResizeBounds(page)
    await expectWidth(page, maximum)
    expect(Number(await handle.getAttribute('aria-valuemin'))).toBe(Math.min(280, maximum))
    const panel = await bounds(panelFor(page))
    expect(panel.x).toBeGreaterThanOrEqual(51)
    expect(panel.x + panel.width).toBeLessThanOrEqual(width)
    expect(await savedWidth(page)).toBe(String(preferred))
    if (width === 390) {
      await expectUsableWorkspace(page)
      await mkdir('tmp', { recursive: true })
      await page.screenshot({ path: 'tmp/codex-resize-mobile.png' })
    }
  }
  await page.setViewportSize({ width: 1512, height: 1100 })
  await waitForResizeBounds(page)
  await expectWidth(page, preferred)
  await page.setViewportSize({ width: 390, height: 844 })
  const handle = separatorFor(page)
  const clamped = await waitForResizeBounds(page)
  await handle.press('ArrowRight')
  await expectWidth(page, clamped - 10)
  await expect.poll(() => savedWidth(page)).toBe(String(clamped - 10))
  await page.setViewportSize({ width: 1512, height: 1100 })
  await expectWidth(page, clamped - 10)
  expect(questions).toEqual([])
})
