import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { selectTool, showAnnotations, useFixedZoom, clickFileAction } from './helpers/reader'

const firstLine = 'Smooth selection begins with a stable reading surface.'
const middleLine = 'Overlapping rectangles should form one clean line.'
const lastLine = 'Release beyond the page, and keep the selected text.'
const nextLine = 'Continue reading here after completing the annotation.'
type Box = { x: number; y: number; width: number; height: number }

async function openInteractionPdf(page: Page, pageCount = 3) {
  // Guard against accidental real CLI questions while exercising its floating entry point.
  await page.route('**/api/codex/ask', route => route.abort())
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
    const sheet = document.addPage([612, 792])
    sheet.drawText(`Interaction paper - page ${pageNumber}`, { x: 52, y: 738, size: 16, font: regular })
    sheet.drawText(firstLine, { x: 52, y: 620, size: 18, font: regular })
    let x = 52
    // Different embedded fonts deliberately split one visual line into multiple text-layer spans.
    for (const [text, font] of [['Overlapping ', regular], ['rectangles ', bold], ['should form one clean line.', regular]] as const) {
      sheet.drawText(text, { x, y: 584, size: 18, font })
      x += font.widthOfTextAtSize(text, 18)
    }
    sheet.drawText(lastLine, { x: 52, y: 548, size: 18, font: regular })
    sheet.drawText(nextLine, { x: 52, y: 494, size: 18, font: regular })
    sheet.drawText(`Reading anchor on page ${pageNumber}`, { x: 52, y: 330, size: 18, font: regular })
  }
  await page.goto('/')
  await expect(page.locator('#page-1 canvas')).toBeVisible()
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'reader-interaction.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) })
  await expect(page.locator('#page-1 .textLayer')).toContainText(firstLine)
  await expect(page.locator('#page-1 .pdf-page-placeholder')).toBeHidden()
  await showAnnotations(page)
  await useFixedZoom(page)
}

const tool = (page: Page, name: string) => page.locator('.tool-list').getByRole('button', { name, exact: true })
const textSpan = (page: Page, text: string, pageNumber = 1) => page.locator(`#page-${pageNumber} .textLayer span`).filter({ hasText: text }).first()
async function box(locator: Locator): Promise<Box> {
  const bounds = await locator.boundingBox()
  expect(bounds).not.toBeNull()
  return bounds!
}
async function beginTextDrag(page: Page, start: Locator, end: Locator = start) {
  const a = await box(start), b = await box(end)
  await page.mouse.move(a.x + 2, a.y + a.height / 2)
  await page.mouse.down()
  await page.mouse.move(b.x + b.width - 2, b.y + b.height / 2, { steps: 12 })
}
async function markRects(locator: Locator) {
  return locator.locator('rect:not(.pdf-mark-outline)').evaluateAll(elements => elements.map(element => ({
    x: Number(element.getAttribute('x')), y: Number(element.getAttribute('y')),
    width: Number(element.getAttribute('width')), height: Number(element.getAttribute('height')),
  })))
}
function overlap(a: Box, b: Box) {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}
async function expectAt(locator: Locator, original: Box) {
  await expect.poll(async () => {
    const current = (await markRects(locator))[0]
    return Math.hypot(current.x - original.x, current.y - original.y)
  }).toBeLessThan(0.2)
}

test('previews real multiline highlighting, merges each line once, and shows Codex only after release', async ({ page }) => {
  await openInteractionPdf(page)
  await selectTool(page, '高亮')
  await beginTextDrag(page, textSpan(page, firstLine), textSpan(page, lastLine))
  const preview = page.locator('#page-1 .pdf-selection-preview')
  await expect(preview).toBeVisible()
  await expect(preview.locator('rect')).toHaveCount(3)
  await expect(page.locator('.annotation-card')).toHaveCount(0)
  await expect(page.locator('.pdf-ask-codex')).toHaveCount(0)
  expect(await textSpan(page, firstLine).evaluate(element => getComputedStyle(element, '::selection').backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/interaction-highlight-preview.png' })
  await page.mouse.up()
  const mark = page.locator('#page-1 .pdf-mark-highlight')
  await expect(mark).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toContainText(firstLine)
  await expect(page.locator('.annotation-card')).toContainText(middleLine)
  await expect(preview).toHaveCount(0)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  const rects = await markRects(mark)
  expect(rects).toHaveLength(3)
  for (let i = 0; i < rects.length; i++) {
    expect(rects[i].width).toBeGreaterThan(100)
    for (let j = i + 1; j < rects.length; j++) expect(overlap(rects[i], rects[j])).toBeLessThan(0.5)
  }
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  const ask = page.locator('#page-1 .pdf-ask-codex')
  await expect(ask).toBeVisible()
  const askBounds = await box(ask)
  for (const rect of await mark.locator('rect').all()) expect(overlap(askBounds, await box(rect))).toBe(0)
  for (const span of await page.locator('#page-1 .textLayer span').all()) expect(overlap(askBounds, await box(span))).toBeLessThan(0.5)
  await page.screenshot({ path: 'tmp/interaction-highlight-committed.png' })
  await beginTextDrag(page, textSpan(page, nextLine))
  await expect(ask).toHaveCount(0)
  await expect(preview).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await expect(preview).toHaveCount(0)
})

test('commits a text highlight released outside the page as one undoable action and clears the browser selection', async ({ page }) => {
  await openInteractionPdf(page)
  await selectTool(page, '高亮')
  await beginTextDrag(page, textSpan(page, firstLine), textSpan(page, lastLine))
  const sheet = await box(page.locator('#page-1'))
  const end = await box(textSpan(page, lastLine))
  await page.mouse.move(sheet.x + sheet.width + 8, end.y + end.height / 2, { steps: 3 })
  await page.mouse.up()
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toContainText('Smooth selection begins')
  await expect(page.locator('.annotation-card')).toContainText('Overlapping rectangles')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await expect(page.locator('.pdf-selection-preview, .pdf-mark-outline')).toHaveCount(0)
  await clickFileAction(page, '撤销')
  await expect(page.locator('.annotation-card')).toHaveCount(0)
  await clickFileAction(page, '重做')
  await expect(page.locator('.annotation-card')).toHaveCount(1)
})

test('selects text through an unselected highlight, applies a new tool to that selection, then moves only a selected mark', async ({ page }) => {
  await openInteractionPdf(page)
  await selectTool(page, '高亮')
  await beginTextDrag(page, textSpan(page, firstLine))
  await page.mouse.up()
  const mark = page.locator('#page-1 .pdf-mark-highlight')
  await expect(mark).toHaveCount(1)
  const original = (await markRects(mark))[0]
  await selectTool(page, '选择文本')
  await beginTextDrag(page, textSpan(page, firstLine))
  expect(await page.evaluate(() => window.getSelection()?.toString())).toContain('Smooth selection begins')
  await expect(mark).not.toHaveClass(/is-dragging/)
  await expectAt(mark, original)
  await page.mouse.up()
  await expect(page.getByRole('toolbar', { name: '选中文字工具', exact: true }).getByRole('button', { name: '问 Codex', exact: true })).toBeVisible()
  await selectTool(page, '下划线')
  await expect(page.locator('#page-1 .pdf-mark-underline')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await selectTool(page, '选择文本')
  const bounds = await box(mark)
  const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
  await page.mouse.click(x, y)
  // At overlapping markup the most recent underline receives the selection, while its text remains selectable beforehand.
  const selected = page.locator('#page-1 .pdf-mark.is-selected')
  await expect(selected).toHaveCount(1)
  const selectedOriginal = (await markRects(selected))[0]
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 35, y + 48, { steps: 10 })
  await expect(selected).toHaveClass(/is-dragging/)
  await page.mouse.up()
  await expect(page.locator('#page-1 .pdf-mark.is-dragging')).toHaveCount(0)
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  const moved = page.locator('#page-1 .pdf-mark-underline')
  const movedRect = (await markRects(moved))[0]
  expect(movedRect.x).toBeCloseTo(selectedOriginal.x + 35, 0)
  expect(movedRect.y).toBeCloseTo(selectedOriginal.y + 48, 0)
  await expectAt(mark, original)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
})

test('cancels note dragging with Escape or a tool switch without recording a move, then clamps a completed move to the page', async ({ page }) => {
  await openInteractionPdf(page)
  await selectTool(page, '便签')
  await page.locator('#page-1').click({ position: { x: 95, y: 370 } })
  await page.getByRole('textbox', { name: '标注内容' }).fill('拖动取消测试')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const note = page.locator('#page-1 .pdf-mark-note')
  const original = (await markRects(note))[0]
  const startDrag = async () => {
    const bounds = await box(note)
    const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2
    await page.mouse.move(x, y); await page.mouse.down()
    await page.mouse.move(x + 65, y + 45, { steps: 10 })
    await expect(note).toHaveClass(/is-dragging/)
  }
  await startDrag()
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expectAt(note, original)
  await expect(note).not.toHaveClass(/is-dragging/)
  await expect(page.getByRole('textbox', { name: '标注内容' })).not.toBeVisible()
  await clickFileAction(page, '撤销')
  await expect(note).toHaveCount(0)
  await clickFileAction(page, '重做')
  await expect(note).toHaveCount(1)
  await startDrag()
  await page.keyboard.press('h')
  await page.mouse.up()
  await expect(tool(page, '拖动阅读')).toHaveAttribute('aria-pressed', 'true')
  await expectAt(note, original)
  await selectTool(page, '选择文本')
  const bounds = await box(note), sheet = await box(page.locator('#page-1'))
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
  await page.mouse.down()
  await page.mouse.move(sheet.x - 25, bounds.y + 60, { steps: 10 })
  await page.mouse.up()
  const clamped = (await markRects(note))[0]
  expect(clamped.x).toBeCloseTo(0, 0)
  expect(clamped.y).toBeGreaterThanOrEqual(0)
  expect(clamped.x + clamped.width).toBeLessThanOrEqual(612.2)
  expect(clamped.y + clamped.height).toBeLessThanOrEqual(792.2)
  await expect(page.getByRole('textbox', { name: '标注内容' })).not.toBeVisible()
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await clickFileAction(page, '撤销')
  await expectAt(note, original)
})

test('keeps the reading anchor while zooming and navigates directly when reduced motion is requested', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openInteractionPdf(page)
  const pageInput = page.getByRole('textbox', { name: '当前页码', exact: true })
  await pageInput.fill('2'); await pageInput.press('Enter')
  await expect(pageInput).toHaveValue('2')
  const anchor = textSpan(page, 'Reading anchor on page 2', 2)
  await expect(anchor).toBeVisible()
  await anchor.evaluate(target => {
    const element = document.querySelector('.document-scroll')!
    const text = target.getBoundingClientRect(), viewport = element.getBoundingClientRect()
    element.scrollTop += text.top + text.height / 2 - (viewport.top + viewport.height / 3)
  })
  const before = await box(anchor)
  const anchorY = before.y + before.height / 2
  const zoom = page.getByRole('combobox', { name: '缩放比例', exact: true })
  for (const value of ['1.5', '1.25']) {
    await zoom.selectOption(value)
    await expect(page.locator('#page-2 .pdf-page-placeholder')).toBeHidden()
    await expect.poll(async () => { const current = await box(anchor); return Math.abs(current.y + current.height / 2 - anchorY) }).toBeLessThan(6)
    await expect(pageInput).toHaveValue('2')
  }
  await page.locator('.document-scroll').evaluate(element => {
    const state = window as unknown as { readerScrollPositions: number[] }
    state.readerScrollPositions = []
    element.addEventListener('scroll', () => state.readerScrollPositions.push(element.scrollTop), { passive: true })
  })
  const start = await page.locator('.document-scroll').evaluate(element => element.scrollTop)
  await pageInput.fill('3'); await pageInput.press('Enter')
  await expect(pageInput).toHaveValue('3')
  await expect(page.locator('#page-3')).toBeInViewport({ ratio: 0.7 })
  const positions = await page.evaluate(() => (window as unknown as { readerScrollPositions: number[] }).readerScrollPositions)
  const final = await page.locator('.document-scroll').evaluate(element => element.scrollTop)
  expect(Math.abs(final - start)).toBeGreaterThan(100)
  expect(positions.every(value => Math.abs(value - start) < 2 || Math.abs(value - final) < 2)).toBe(true)
})

test('tracks the visible page while scrolling a long PDF and leaves the reading position unchanged on an unedited page field blur', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openInteractionPdf(page, 80)
  const pageInput = page.getByRole('textbox', { name: '当前页码', exact: true })
  const viewer = page.locator('.document-scroll')
  for (const pageNumber of [47, 79, 12]) {
    await viewer.evaluate((element, number) => {
      const target = document.getElementById(`page-${number}`)!
      element.scrollTop = target.offsetTop + 200
    }, pageNumber)
    await expect(pageInput).toHaveValue(String(pageNumber))
    await expect(page.locator(`#page-${pageNumber} .textLayer`)).toContainText(`Interaction paper - page ${pageNumber}`)
  }
  const before = await viewer.evaluate(element => element.scrollTop)
  await pageInput.focus()
  await pageInput.press('Tab')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await viewer.evaluate(element => element.scrollTop)).toBeCloseTo(before, 0)
  await expect(pageInput).toHaveValue('12')
  await pageInput.fill('79')
  await pageInput.press('Escape')
  await expect(pageInput).toHaveValue('12')
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  expect(await viewer.evaluate(element => element.scrollTop)).toBeCloseTo(before, 0)
})

test('ignores repeated current tool and zoom choices without restoring a stale reading position on Escape', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openInteractionPdf(page)
  const viewer = page.locator('.document-scroll')
  const scrollThenEscape = async (distance: number) => {
    const start = await viewer.evaluate(element => element.scrollTop)
    await viewer.evaluate((element, delta) => { element.scrollTop += delta }, distance)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const scrolled = await viewer.evaluate(element => element.scrollTop)
    expect(scrolled - start).toBeCloseTo(distance, 0)
    await page.keyboard.press('Escape')
    await expect(tool(page, '选择文本')).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    expect(await viewer.evaluate(element => element.scrollTop)).toBeCloseTo(scrolled, 0)
  }
  await selectTool(page, '拖动阅读')
  await selectTool(page, '拖动阅读')
  await scrollThenEscape(200)
  await selectTool(page, '拖动阅读')
  const zoom = page.getByRole('combobox', { name: '缩放比例', exact: true })
  await zoom.selectOption(await zoom.inputValue())
  await zoom.blur()
  await scrollThenEscape(175)
})
