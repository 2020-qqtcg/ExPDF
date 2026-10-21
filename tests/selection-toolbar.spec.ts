import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdir, readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib'
import { selectTool, showAnnotations, useFixedZoom, clickFileAction, fileAction, closeFileMenu } from './helpers/reader'

const lines = ['Select this first line.', 'Keep both fonts here.', 'Finish with this line.']
const toolbarFor = (page: Page) => page.getByRole('toolbar', { name: '选中文字工具', exact: true })
const textFor = (page: Page, text: string) => page.locator('#page-1 .textLayer span').filter({ hasText: text }).first()
type Bounds = { x: number; y: number; width: number; height: number }

async function bounds(locator: Locator): Promise<Bounds> {
  const result = await locator.boundingBox()
  expect(result).not.toBeNull()
  return result!
}

async function openSelectionPdf(page: Page, zoom = '1') {
  const modelCalls: string[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: {
    defaultModel: 'selection-test',
    models: [{ id: 'selection-test', name: 'Selection test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }],
  } }))
  // Opening the assistant is safe to exercise; these tests never invoke the installed CLI.
  await page.route('**/api/codex/ask', route => {
    modelCalls.push(route.request().postData() ?? '')
    return route.fulfill({ status: 500, json: { error: 'Unexpected model request in a selection-only test' } })
  })
  const document = await PDFDocument.create()
  const regular = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)
  const sheet = document.addPage([612, 792])
  sheet.drawText('Floating selection toolbar', { x: 52, y: 738, size: 18, font: regular })
  sheet.drawText(lines[0], { x: 52, y: 612, size: 14, font: regular })
  const prefix = 'Keep both '
  sheet.drawText(prefix, { x: 52, y: 576, size: 14, font: regular })
  sheet.drawText('fonts here.', { x: 52 + regular.widthOfTextAtSize(prefix, 14), y: 576, size: 14, font: bold })
  sheet.drawText(lines[2], { x: 52, y: 540, size: 14, font: regular })
  sheet.drawText('An unselected paragraph remains untouched.', { x: 52, y: 440, size: 14, font: regular })
  await page.goto('/')
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'selection-toolbar.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) })
  await expect(page.locator('#page-1 .textLayer')).toContainText(lines[0])
  await expect(page.locator('#page-1 .pdf-page-placeholder')).toBeHidden()
  await useFixedZoom(page, zoom)
  await selectTool(page, '选择文本')
  return modelCalls
}

async function selectPassage(page: Page) {
  const first = await bounds(textFor(page, lines[0]))
  const last = await bounds(textFor(page, lines[2]))
  await page.mouse.move(first.x + 1, first.y + first.height / 2)
  await page.mouse.down()
  await page.mouse.move(last.x + last.width + 2, last.y + last.height / 2, { steps: 16 })
  await expect(toolbarFor(page)).toHaveCount(0)
  await page.mouse.up()
  await expect(toolbarFor(page)).toBeVisible()
  const text = await page.evaluate(() => window.getSelection()?.toString() ?? '')
  for (const line of lines) expect(text.replace(/\s+/g, ' ')).toContain(line)
  expect(text).not.toContain('An unselected paragraph')
  const selectedBounds = await page.evaluate(() => Array.from(window.getSelection()!.getRangeAt(0).getClientRects())
    .filter(rect => rect.width > 1 && rect.height > 1)
    .map(rect => ({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })))
  return { text, first: selectedBounds[0], last: selectedBounds[selectedBounds.length - 1] }
}

async function expectSelectionResult(page: Page, remainingText = '') {
  await expect(toolbarFor(page)).toHaveCount(0)
  await expect(page.locator('.pdf-selection-preview, .pdf-mark-outline')).toHaveCount(0)
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(remainingText)
}

async function downloadedPdf(page: Page) {
  const download = page.waitForEvent('download')
  await clickFileAction(page, '导出 PDF')
  const path = await (await download).path()
  expect(path).toBeTruthy()
  return PDFDocument.load(await readFile(path!))
}

const nativeAnnotations = (document: PDFDocument) => document.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
  .asArray().map(reference => document.context.lookup(reference, PDFDict))

test('applies all four text marks from the real selection toolbar as single persistent actions and exports editable PDF markup', async ({ page }) => {
  const calls = await openSelectionPdf(page)
  const kinds = [
    { label: '高亮', kind: 'highlight', subtype: '/Highlight' },
    { label: '删除线', kind: 'strikeout', subtype: '/StrikeOut' },
    { label: '下划线', kind: 'underline', subtype: '/Underline' },
    { label: '波浪线', kind: 'squiggly', subtype: '/Squiggly' },
  ]
  for (const [index, choice] of kinds.entries()) {
    const { first } = await selectPassage(page)
    const toolbar = toolbarFor(page)
    if (index === 0) {
      expect(await toolbar.getByRole('button').evaluateAll(buttons => buttons.slice(0, 6).map(button => button.getAttribute('aria-label'))))
        .toEqual(['问 Codex', '高亮', '删除线', '下划线', '波浪线', '批注'])
      for (const disabled of ['编辑', '添加书签', '朗读']) await expect(toolbar.getByRole('button', { name: disabled, exact: true })).toBeDisabled()
      await expect(toolbar.getByRole('button', { name: '复制', exact: true })).toBeEnabled()
      expect(await toolbar.evaluate(element => !!element.closest('.reader-area') && !element.closest('.pdf-page'))).toBe(true)
      const area = await bounds(page.locator('.reader-area'))
      const floating = await bounds(toolbar)
      expect(floating.width).toBeCloseTo(488, 0)
      expect(floating.height).toBeCloseTo(40, 0)
      expect(floating.y + floating.height).toBeCloseTo(first.y - 8, 0)
      expect(floating.x).toBeGreaterThanOrEqual(area.x)
      expect(floating.x + floating.width).toBeLessThanOrEqual(area.x + area.width)
      await mkdir('tmp', { recursive: true })
      await page.screenshot({ path: 'tmp/selection-toolbar-desktop.png' })
    }
    await toolbar.getByRole('button', { name: choice.label, exact: true }).click()
    await expect(page.locator(`#page-1 .pdf-mark-${choice.kind}`)).toHaveCount(1)
    await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(index + 1)
    await expectSelectionResult(page)
    await clickFileAction(page, '撤销')
    await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(index)
    await clickFileAction(page, '重做')
    await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(index + 1)
  }
  await showAnnotations(page)
  await expect(page.locator('.annotation-card')).toHaveCount(4)
  for (const card of await page.locator('.annotation-card').all()) {
    for (const line of lines) await expect(card).toContainText(line)
  }
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(4)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  const document = await downloadedPdf(page)
  const annotations = nativeAnnotations(document)
  expect(annotations).toHaveLength(4)
  expect(new Set(annotations.map(annotation => annotation.lookup(PDFName.of('C'), PDFArray).toString())).size).toBe(4)
  for (const choice of kinds) {
    const annotation = annotations.find(value => value.get(PDFName.of('Subtype'))?.toString() === choice.subtype)
    expect(annotation).toBeTruthy()
    const quadPoints = annotation!.lookup(PDFName.of('QuadPoints'), PDFArray).asArray().map(value => Number(value.toString()))
    expect(quadPoints).toHaveLength(24)
    for (let line = 0; line < 3; line++) {
      const offset = line * 8
      expect(quadPoints[offset + 2] - quadPoints[offset]).toBeGreaterThan(80)
      expect(quadPoints[offset + 1] - quadPoints[offset + 5]).toBeGreaterThan(8)
      if (line) expect(quadPoints[offset + 1]).toBeLessThan(quadPoints[offset - 3])
    }
    const appearance = annotation!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream)
    const commands = inflateSync(appearance.getContents()).toString('utf8')
    expect(commands.length).toBeGreaterThan(50)
    if (choice.kind === 'squiggly') expect(commands).toMatch(/ c\n/)
  }
  expect(calls).toEqual([])
})

test('adds a quoted inline comment, cancels without creating undo history, and persists the completed Chinese note', async ({ page }) => {
  const calls = await openSelectionPdf(page)
  await selectPassage(page)
  await toolbarFor(page).getByRole('button', { name: '批注', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加批注', exact: true })
  const editor = dialog.getByRole('textbox', { name: '标注内容', exact: true })
  await expect(editor).toBeFocused()
  await editor.fill('这条取消的批注不应保留。')
  await dialog.getByRole('button', { name: '取消', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(0)
  await expect(await fileAction(page, '撤销')).toBeDisabled()
  await closeFileMenu(page)

  await selectPassage(page)
  await toolbarFor(page).getByRole('button', { name: '批注', exact: true }).click()
  const comment = '中文批注：请结合这三行的上下文再次核对。'
  await editor.fill(comment)
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/selection-comment-desktop.png' })
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await expectSelectionResult(page)
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('#page-1 .pdf-mark-note')).toHaveCount(1)
  await showAnnotations(page)
  const card = page.locator('.annotation-card')
  await expect(card).toHaveCount(1)
  await expect(card.locator('.annotation-comment')).toHaveText(comment)
  for (const line of lines) await expect(card.locator('blockquote')).toContainText(line)
  await clickFileAction(page, '撤销')
  await expect(card).toHaveCount(0)
  await clickFileAction(page, '重做')
  await expect(card).toHaveCount(1)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await showAnnotations(page)
  await expect(card.locator('.annotation-comment')).toHaveText(comment)
  for (const line of lines) await expect(card.locator('blockquote')).toContainText(line)
  const annotations = nativeAnnotations(await downloadedPdf(page))
  expect(annotations).toHaveLength(1)
  expect(annotations[0].get(PDFName.of('Subtype'))?.toString()).toBe('/Text')
  const contents = annotations[0].lookup(PDFName.of('Contents'))
  expect(contents instanceof PDFString || contents instanceof PDFHexString ? contents.decodeText() : '').toBe(comment)
  expect(calls).toEqual([])
})

test('copies only the selected text, dismisses the toolbar after asynchronous success, and preserves it when copying fails', async ({ page }) => {
  await page.addInitScript(() => {
    const state = window as unknown as { selectionClipboard: { mode: string; values: string[]; finish?: () => void } }
    state.selectionClipboard = { mode: 'pending', values: [] }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => {
        state.selectionClipboard.values.push(value)
        if (state.selectionClipboard.mode === 'failure') throw new Error('Clipboard permission denied for this test')
        if (state.selectionClipboard.mode === 'pending') await new Promise<void>(resolve => { state.selectionClipboard.finish = resolve })
      },
    } })
  })
  const calls = await openSelectionPdf(page)
  const { text } = await selectPassage(page)
  await toolbarFor(page).getByRole('button', { name: '复制', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { selectionClipboard: { values: string[] } }).selectionClipboard.values)).toEqual([text])
  await expect(toolbarFor(page)).toBeVisible()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(text)
  await page.evaluate(() => (window as unknown as { selectionClipboard: { finish: () => void } }).selectionClipboard.finish())
  await expectSelectionResult(page, text)
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(0)

  // A drag beginning inside the preserved blue selection starts native text dragging.
  // Deselect it as a reader would before making another fresh selection.
  await page.locator('#page-1').click({ position: { x: 500, y: 580 } })
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await selectPassage(page)
  await page.evaluate(() => { (window as unknown as { selectionClipboard: { mode: string } }).selectionClipboard.mode = 'failure' })
  await toolbarFor(page).getByRole('button', { name: '复制', exact: true }).click()
  await expect(page.getByText(/复制失败|无法复制|剪贴板/).last()).toBeVisible()
  await expect(toolbarFor(page)).toBeVisible()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(text)
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(0)
  await page.evaluate(() => { (window as unknown as { selectionClipboard: { mode: string } }).selectionClipboard.mode = 'success' })
  await toolbarFor(page).getByRole('button', { name: '复制', exact: true }).click()
  await expectSelectionResult(page, text)
  expect(calls).toEqual([])
})

test('keeps the selection toolbar usable on a narrow screen and passes its quote to Codex without sending a question', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const calls = await openSelectionPdf(page, '0.5')
  const { text } = await selectPassage(page)
  const toolbar = toolbarFor(page)
  const floating = await bounds(toolbar)
  const area = await bounds(page.locator('.reader-area'))
  expect(floating.x).toBeGreaterThanOrEqual(area.x)
  expect(floating.x + floating.width).toBeLessThanOrEqual(390)
  expect(floating.y).toBeGreaterThanOrEqual(40)
  expect(floating.height).toBeCloseTo(40, 0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await toolbar.getByRole('button', { name: '复制', exact: true }).scrollIntoViewIfNeeded()
  await expect(toolbar.getByRole('button', { name: '复制', exact: true })).toBeInViewport({ ratio: 1 })
  await toolbar.getByRole('button', { name: '问 Codex', exact: true }).scrollIntoViewIfNeeded()
  await expect(toolbar.getByRole('button', { name: '问 Codex', exact: true })).toBeInViewport({ ratio: 1 })
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/selection-toolbar-mobile.png' })
  await toolbar.getByRole('button', { name: '问 Codex', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Codex 问答', exact: true })
  await expect(panel).toBeVisible()
  await expect(panel.locator('.codex-source blockquote')).toHaveText(text)
  await expect(panel.locator('.codex-source')).toContainText('第 1 页摘录')
  await expectSelectionResult(page)
  await expect(page.locator('#page-1 .pdf-mark')).toHaveCount(0)
  expect(calls).toEqual([])
})
