import { test, expect, type Locator, type Page } from '@playwright/test'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, PDFHexString, StandardFonts, rgb } from 'pdf-lib'
import { readFile } from 'node:fs/promises'
import { clickReadingControl, openFileMenu, selectTool, showAnnotations, useFixedZoom, clickFileAction, fileAction, closeFileMenu } from './helpers/reader'

const fixtureName = 'acceptance-reader.pdf'
const chineseComment = '中文批注：这段内容需要再次确认。'

async function makeFixture(title = 'Folio acceptance PDF') {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let index = 1; index <= 3; index++) {
    const page = document.addPage([612, 792])
    page.drawText(`${title} - page ${index}`, { x: 56, y: 720, size: 22, font, color: rgb(0.12, 0.16, 0.2) })
    page.drawText('Select this sentence to test native PDF annotations.', { x: 56, y: 672, size: 15, font })
    page.drawText(`Searchable needle${index} and persistent reading progress.`, { x: 56, y: 640, size: 15, font })
  }
  return Buffer.from(await document.save())
}

async function openFixture(page: Page, name = fixtureName, title = 'Folio acceptance PDF') {
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name, mimeType: 'application/pdf', buffer: await makeFixture(title) })
  await expect(page.locator('#page-1 .textLayer')).toContainText(title)
  await showAnnotations(page)
  await useFixedZoom(page)
}

async function uploadFixture(page: Page, name = fixtureName, title = 'Folio acceptance PDF') {
  await page.goto('/')
  await expect(page.locator('.pdf-page').first()).toBeVisible()
  await openFixture(page, name, title)
}

async function selectText(page: Page, text: string, tool: '高亮' | '下划线' | '删除线' = '高亮') {
  await selectTool(page, tool)
  const span = page.locator('#page-1 .textLayer span').filter({ hasText: text }).first()
  await expect(span).toBeVisible()
  await span.evaluate((element) => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
}

async function addNote(page: Page, content = chineseComment) {
  await selectTool(page, '便签')
  await page.locator('#page-1').click({ position: { x: 95, y: 265 } })
  const editor = page.getByRole('textbox', { name: '标注内容' })
  await expect(editor).toBeVisible()
  await editor.fill(content)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.annotation-card').filter({ hasText: content })).toBeVisible()
}

async function chooseMoreAction(page: Page, name: '搜索' | '书签') {
  await page.getByLabel('更多', { exact: true }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${name}`) }).click()
}

async function markRect(marker: Locator) {
  return marker.locator('rect:not(.pdf-mark-outline)').first().evaluate(element => ({
    x: Number(element.getAttribute('x')),
    y: Number(element.getAttribute('y')),
    width: Number(element.getAttribute('width')),
    height: Number(element.getAttribute('height')),
  }))
}

async function dragMark(page: Page, marker: Locator, dx: number, dy: number) {
  const bounds = await marker.boundingBox()
  expect(bounds).toBeTruthy()
  const x = bounds!.x + bounds!.width / 2
  const y = bounds!.y + bounds!.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y + dy, { steps: 12 })
  await page.mouse.up()
}

async function expectMarkAt(marker: Locator, position: { x: number; y: number }) {
  await expect.poll(async () => {
    const actual = await markRect(marker)
    return Math.hypot(actual.x - position.x, actual.y - position.y)
  }).toBeLessThan(0.2)
}

test('opens the real four-page demo with selectable text and page controls', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.locator('.pdf-page')).toHaveCount(4)
  await expect(page.locator('#page-1 canvas')).toBeVisible()
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  await expect(await openFileMenu(page)).toBeVisible()
  await expect(await fileAction(page, '导出 PDF')).toBeVisible()
  await closeFileMenu(page)
  const toolbar = await page.locator('.toolbar').boundingBox()
  expect(toolbar?.height).toBeLessThanOrEqual(60)
  await expect.poll(() => page.locator('#page-1').evaluate(element => element.getBoundingClientRect().top)).toBeLessThanOrEqual(145)
  expect(errors).toEqual([])
})

test('uploads PDFs, creates text markup, and persists annotations across reloads', async ({ page }) => {
  await uploadFixture(page)
  await selectText(page, 'Select this sentence', '高亮')
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await selectText(page, 'Searchable needle1', '下划线')
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await selectText(page, 'Folio acceptance PDF', '删除线')
  await expect(page.locator('.annotation-card')).toHaveCount(3)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(page.locator('#page-1 .textLayer')).toContainText('Folio acceptance PDF')
  await showAnnotations(page)
  await useFixedZoom(page)
  await expect(page.locator('.annotation-card')).toHaveCount(3)
})

test('creates and edits notes, deletes them, and restores them with undo/redo', async ({ page }) => {
  await uploadFixture(page)
  await addNote(page)
  const card = page.locator('.annotation-card').filter({ hasText: chineseComment })
  await card.click()
  const editedComment = '修改后的中文便签：已经核对。'
  await page.getByRole('textbox', { name: '标注内容' }).fill(editedComment)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  const editedCard = page.locator('.annotation-card').filter({ hasText: editedComment })
  await expect(editedCard).toBeVisible()
  await editedCard.getByRole('button', { name: '删除标注' }).click()
  await expect(page.locator('.annotation-card')).toHaveCount(0)
  await clickFileAction(page, '撤销')
  await expect(page.locator('.annotation-card').filter({ hasText: editedComment })).toBeVisible()
  await clickFileAction(page, '重做')
  await expect(page.locator('.annotation-card')).toHaveCount(0)
})

test('supports zoom, page navigation, and text search', async ({ page }) => {
  await uploadFixture(page)
  const firstPage = page.locator('#page-1')
  const originalWidth = await firstPage.evaluate((element) => element.getBoundingClientRect().width)
  await clickReadingControl(page, '放大')
  await expect.poll(() => firstPage.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(originalWidth)
  await clickReadingControl(page, '缩小')
  await expect.poll(() => firstPage.evaluate((element) => element.getBoundingClientRect().width)).toBeCloseTo(originalWidth, 0)
  await clickReadingControl(page, '下一页')
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('2')
  await expect(page.locator('#page-2')).toBeInViewport({ ratio: 0.75 })
  await chooseMoreAction(page, '书签')
  await page.getByRole('button', { name: '页面书签', exact: true }).click()
  await expect(page.locator('.bookmark-list').getByRole('button', { name: '第 2 页', exact: true })).toBeVisible()
  await clickReadingControl(page, '上一页')
  await expect(firstPage).toBeInViewport({ ratio: 0.5 })
  await chooseMoreAction(page, '搜索')
  await page.getByLabel('搜索文档').fill('needle3')
  await expect(page.locator('#page-3 mark.pdf-search-mark')).toHaveText('needle3')
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('3')
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('3')
  await page.getByRole('button', { name: '页面书签', exact: true }).click()
  await expect(page.locator('.bookmark-list').getByRole('button', { name: '第 2 页', exact: true })).toBeVisible()
})

test('reopens historical PDFs with their own saved page and notes without uploading again', async ({ page }) => {
  const firstName = 'history-alpha.pdf'
  const secondName = 'history-beta.pdf'
  const note = '历史文件 A 的阅读笔记。'
  let fileChooserCount = 0
  page.on('filechooser', () => fileChooserCount++)
  await uploadFixture(page, firstName, 'History Alpha PDF')
  await addNote(page, note)
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('2')
  await expect(page.locator('#page-2')).toBeInViewport({ ratio: 0.75 })
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')

  await openFixture(page, secondName, 'History Beta PDF')
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('1')
  await expect(page.locator('.annotation-card')).toHaveCount(0)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.getByRole('button', { name: '最近阅读', exact: true }).click()
  const history = page.locator('.recent-popover')
  const firstRow = history.getByRole('button', { name: `打开历史 PDF：${firstName}`, exact: true })
  const secondRow = history.getByRole('button', { name: `打开历史 PDF：${secondName}`, exact: true })
  await expect(history).toBeVisible()
  await expect(firstRow).toHaveCount(1)
  await expect(secondRow).toContainText('当前文件')
  await history.getByLabel('搜索历史 PDF').fill('history-alpha')
  await expect(firstRow).toBeVisible()
  await expect(secondRow).toHaveCount(0)
  await firstRow.click()
  await expect(history).not.toBeVisible()
  await expect(page.locator('#page-2 .textLayer')).toContainText('History Alpha PDF')
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('2')
  await expect(page.locator('.annotation-card').filter({ hasText: note })).toBeVisible()
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')

  await page.reload()
  await expect(page.locator('#page-2 .textLayer')).toContainText('History Alpha PDF')
  await showAnnotations(page)
  await useFixedZoom(page)
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('2')
  await expect(page.locator('.annotation-card').filter({ hasText: note })).toBeVisible()
  await page.getByRole('button', { name: '最近阅读', exact: true }).click()
  await history.getByLabel('搜索历史 PDF').fill('')
  await expect(firstRow).toHaveCount(1)
  await expect(firstRow).toContainText('当前文件')
  await expect(secondRow).toHaveCount(1)
  await secondRow.click()
  await expect(history).not.toBeVisible()
  await expect(page.locator('#page-1 .textLayer')).toContainText('History Beta PDF')
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('1')
  await expect(page.locator('.annotation-card')).toHaveCount(0)
  await page.getByRole('button', { name: '最近阅读', exact: true }).click()
  await history.getByLabel('搜索历史 PDF').fill('')
  await expect(firstRow).toHaveCount(1)
  await expect(secondRow).toHaveCount(1)
  await expect(secondRow).toContainText('当前文件')
  expect(fileChooserCount).toBe(0)
})

test('drags existing notes and highlights at zoom and rotation, with undo, persistence, and native export', async ({ page }) => {
  await uploadFixture(page)
  await selectText(page, 'Select this sentence')
  await addNote(page)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await page.getByRole('combobox', { name: '缩放比例' }).selectOption('1.25')
  await page.getByRole('button', { name: '旋转页面', exact: true }).click()
  await selectTool(page, '选择文本')
  const pageSvg = page.locator('#page-1 .pdf-annotation-layer')
  await expect.poll(() => pageSvg.evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(792 * 1.25, 0)
  const note = page.locator('#page-1 .pdf-mark-note')
  const highlight = page.locator('#page-1 .pdf-mark-highlight')
  const originalNote = await markRect(note)
  await dragMark(page, note, 60, 40)
  const movedNote = { ...originalNote, x: originalNote.x + 60, y: originalNote.y + 40 }
  await expectMarkAt(note, movedNote)
  await expect(page.getByRole('textbox', { name: '标注内容' })).not.toBeVisible()
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await note.click()
  await expect(page.getByRole('textbox', { name: '标注内容' })).toHaveValue(chineseComment)
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await clickFileAction(page, '撤销')
  await expectMarkAt(note, originalNote)
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await clickFileAction(page, '重做')
  await expectMarkAt(note, movedNote)

  const originalHighlight = await markRect(highlight)
  await highlight.scrollIntoViewIfNeeded()
  const highlightBounds = await highlight.boundingBox()
  await page.mouse.click(highlightBounds!.x + highlightBounds!.width / 2, highlightBounds!.y + highlightBounds!.height / 2)
  await dragMark(page, highlight, -30, 50)
  const movedHighlight = { ...originalHighlight, x: originalHighlight.x - 30, y: originalHighlight.y + 50 }
  await expectMarkAt(highlight, movedHighlight)
  await expect(page.getByRole('textbox', { name: '标注内容' })).not.toBeVisible()
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)

  // At 90 degrees PDF.js maps native PDF (x,y) to viewport (y*scale,x*scale).
  const nativeRect = (rect: typeof originalNote) => [
    rect.y / 1.25, rect.x / 1.25,
    (rect.y + rect.height) / 1.25, (rect.x + rect.width) / 1.25,
  ]
  const expectedNote = nativeRect(movedNote)
  const expectedHighlight = nativeRect(movedHighlight)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(page.locator('#page-1 .textLayer')).toContainText('Folio acceptance PDF')
  await showAnnotations(page)
  await useFixedZoom(page)
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  // Reload restores the page to its ordinary unrotated, 100% viewport.
  await expectMarkAt(note, { x: expectedNote[0], y: 792 - expectedNote[3] })
  await expectMarkAt(highlight, { x: expectedHighlight[0], y: 792 - expectedHighlight[3] })
  const downloadPromise = page.waitForEvent('download')
  await clickFileAction(page, '导出 PDF')
  const download = await downloadPromise
  const filePath = await download.path()
  const document = await PDFDocument.load(await readFile(filePath!))
  const annotations = document.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
    .asArray().map(ref => document.context.lookup(ref, PDFDict))
  for (const [subtype, expected] of [['/Text', expectedNote], ['/Highlight', expectedHighlight]] as const) {
    const annotation = annotations.find(value => value.get(PDFName.of('Subtype'))?.toString() === subtype)
    expect(annotation).toBeTruthy()
    const rect = annotation!.lookup(PDFName.of('Rect'), PDFArray).asArray().map(value => Number(value.toString()))
    for (let index = 0; index < 4; index++) expect(rect[index]).toBeCloseTo(expected[index], 1)
  }
})

test('exports native PDF markup and Unicode note contents', async ({ page }) => {
  await uploadFixture(page)
  await selectText(page, 'Select this sentence')
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await selectText(page, 'Searchable needle1', '下划线')
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await selectText(page, 'Folio acceptance PDF', '删除线')
  await expect(page.locator('.annotation-card')).toHaveCount(3)
  await addNote(page)
  await page.getByRole('button', { name: '自由绘制', exact: true }).click()
  const bounds = await page.locator('#page-1').boundingBox()
  expect(bounds).toBeTruthy()
  await page.mouse.move(bounds!.x + 100, bounds!.y + 330)
  await page.mouse.down()
  await page.mouse.move(bounds!.x + 150, bounds!.y + 355, { steps: 8 })
  await page.mouse.move(bounds!.x + 230, bounds!.y + 335, { steps: 8 })
  await page.mouse.up()
  await expect(page.locator('.annotation-card')).toHaveCount(5)
  const downloadPromise = page.waitForEvent('download')
  await clickFileAction(page, '导出 PDF')
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i)
  const filePath = await download.path()
  expect(filePath).toBeTruthy()
  const document = await PDFDocument.load(await readFile(filePath!))
  expect(document.getPageCount()).toBe(3)
  const annotations = document.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
  const nativeAnnotations = annotations.asArray().map((ref) => document.context.lookup(ref, PDFDict))
  const subtypes = nativeAnnotations.map((annotation) => annotation.get(PDFName.of('Subtype'))?.toString())
  expect(subtypes).toContain('/Highlight')
  expect(subtypes).toContain('/Underline')
  expect(subtypes).toContain('/StrikeOut')
  expect(subtypes).toContain('/Text')
  expect(subtypes).toContain('/Ink')
  for (const annotation of nativeAnnotations) {
    expect(annotation.lookup(PDFName.of('Rect'), PDFArray).size()).toBe(4)
    expect(annotation.has(PDFName.of('AP'))).toBe(true)
  }
  const contents = nativeAnnotations.map((annotation) => {
    const value = annotation.lookup(PDFName.of('Contents'))
    return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : ''
  })
  expect(contents).toContain(chineseComment)
})
