import { clickFileAction } from './helpers/reader'
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream } from 'pdf-lib'

interface LocalFont {
  id: string
  family: string
  fullName: string
  postscriptName: string
  localizedFullName?: string
  aliases?: string[]
}

test('finds Chinese system fonts by their Chinese names and exports their actual Chinese glyphs', async ({ page }, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  const source = await PDFDocument.create()
  source.addPage([612, 792])
  await page.goto('/')
  await expect(page.locator('#page-1 canvas')).toBeVisible()
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'chinese-fonts.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await source.save()) })
  await expect(page).toHaveTitle(/chinese-fonts\.pdf/)
  const response = await page.request.get('/api/fonts')
  expect(response.ok()).toBeTruthy()
  const fonts = await response.json() as LocalFont[]
  const selected: { font: LocalFont; content: string }[] = []
  for (const [index, keyword] of ['苹方', '楷体'].entries()) {
    const matches = fonts.filter(font => [font.family, font.fullName, font.localizedFullName, ...(font.aliases ?? [])].join(' ').includes(keyword))
    expect(matches.length, `${keyword} must be discovered from the local Chinese font assets`).toBeGreaterThan(0)
    const font = matches.find(candidate => /(?:PingFangSC|KaitiSC|KaiTiSC)-Regular/.test(candidate.postscriptName))
      ?? matches.find(candidate => /SC|简/.test(candidate.postscriptName + candidate.family)) ?? matches[0]
    await page.getByRole('button', { name: '添加文字', exact: true }).click()
    await page.getByLabel('筛选字体', { exact: true }).fill(keyword)
    const picker = page.getByLabel('字体', { exact: true })
    await expect(picker.locator(`option[value="${font.id}"]`)).toHaveCount(1)
    await picker.selectOption(font.id)
    await expect(picker).toHaveValue(font.id)
    await expect(picker.locator('option:checked')).toContainText(keyword)
    await expect(picker.locator('option:checked')).toContainText(font.fullName)
    await page.getByLabel('字号', { exact: true }).fill('22')
    await page.locator('#page-1').click({ position: { x: 80, y: 180 + index * 160 } })
    const content = `${keyword}字体中文批注，导出后完整保留。`
    await page.getByRole('textbox', { name: '页面文字', exact: true }).fill(content)
    await page.getByRole('button', { name: '完成', exact: true }).click()
    await expect(page.locator('.pdf-mark-text')).toHaveCount(index + 1)
    await expect(page.locator('.pdf-mark-text text').nth(index)).toContainText(content)
    selected.push({ font, content })
  }
  const downloadEvent = page.waitForEvent('download')
  await clickFileAction(page, '导出 PDF')
  const failure = page.getByRole('status').filter({ hasText: /失败|无法|不包含|不支持/ })
  const download = await Promise.race([
    downloadEvent,
    failure.waitFor({ state: 'visible' }).then(async () => { throw new Error(`PDF 导出错误：${await failure.textContent()}`) }),
  ])
  const outputPath = testInfo.outputPath('chinese-fonts.pdf')
  await download.saveAs(outputPath)
  const output = await PDFDocument.load(await readFile(outputPath))
  const annotations = output.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
    .asArray().map(reference => output.context.lookup(reference, PDFDict))
    .filter(annotation => annotation.get(PDFName.of('Subtype'))?.toString() === '/FreeText')
  expect(annotations).toHaveLength(2)
  for (const { font, content } of selected) {
    const annotation = annotations.find(value => value.lookup(PDFName.of('Contents'), PDFHexString).decodeText() === content)
    expect(annotation).toBeTruthy()
    const appearance = annotation!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream)
    const resources = appearance.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    const embedded = resources.lookup(resources.keys()[0], PDFDict)
    expect(embedded.lookup(PDFName.of('BaseFont'), PDFName).decodeText()).toContain(font.postscriptName)
    const unicode = inflateSync(embedded.lookup(PDFName.of('ToUnicode'), PDFRawStream).getContents()).toString('utf8').toUpperCase()
    for (const character of content) expect(unicode).toContain(character.codePointAt(0)!.toString(16).toUpperCase())
    const descriptor = embedded.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('FontDescriptor'), PDFDict)
    const fontFile = descriptor.lookup(PDFName.of(descriptor.has(PDFName.of('FontFile2')) ? 'FontFile2' : 'FontFile3'), PDFRawStream)
    expect(fontFile.getContentsSize()).toBeGreaterThan(100)
  }
  expect(errors).toEqual([])
})
