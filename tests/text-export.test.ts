import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import fontkit from '@pdf-lib/fontkit'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFString, StandardFonts } from 'pdf-lib'
import { exportAnnotatedPdf } from '../src/lib/export.ts'
import type { Annotation, FontAsset, TextStyle } from '../src/types.ts'

async function notoAsset(id = 'test-noto'): Promise<FontAsset> {
  const bytes = new Uint8Array(await readFile(new URL('../public/fonts/NotoSansCJKsc-Regular.otf', import.meta.url)))
  const face = fontkit.create(bytes)
  return { id, bytes, family: 'Noto Sans CJK SC', fullName: 'Noto Sans CJK SC Regular', postscriptName: face.postscriptName ?? '', style: 'Regular', weight: 400, italic: false, source: 'bundled' }
}

async function sourcePdf() {
  const document = await PDFDocument.create()
  const page = document.addPage([600, 800])
  const font = await document.embedFont(StandardFonts.Helvetica)
  page.drawText('Original selectable content', { x: 40, y: 750, size: 12, font })
  document.addPage([400, 500])
  return document.save()
}

function textAnnotation(id: string, text: string, style: Partial<TextStyle> = {}): Annotation {
  return {
    id, kind: 'text', page: 1, color: '#1256ab', text, comment: 'Editor-only comment',
    createdAt: 1_700_000_000_000, points: [{ x: 100, y: 700 }],
    rects: [{ x: 100, y: 640, width: 200, height: 60 }], textLines: text.split('\n'),
    textStyle: { fontId: 'test-noto', fontFamily: 'Noto Sans CJK SC', fontName: 'Noto Sans CJK SC Regular', fontSize: 20, bold: false, italic: false, underline: false, align: 'left', lineHeight: 1.5, width: 200, rotation: 0, ...style },
  }
}

function appearance(annotation: PDFDict) {
  return annotation.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream)
}

function decoded(stream: PDFRawStream) {
  return inflateSync(stream.getContents()).toString('utf8')
}

function matrices(commands: string) {
  return [...commands.matchAll(/([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) ([-\d.]+) Tm/g)]
    .map(match => match.slice(1).map(Number))
}

test('FreeText embeds Unicode font programs and preserves formatted Chinese multiline text and rotated coordinates', async () => {
  const asset = await notoAsset()
  const source = await sourcePdf()
  const sourceDocument = await PDFDocument.load(source)
  const sourceContent = sourceDocument.getPages()[0].node.lookup(PDFName.of('Contents'), PDFArray)
    .lookup(0, PDFRawStream).getContentsString()
  const annotation = textAnnotation('unicode-text', '中文标题\n下一行文字', { bold: true, italic: true, underline: true, align: 'center', rotation: 90 })
  annotation.points = [{ x: 100, y: 500 }]
  annotation.rects = [{ x: 100, y: 500, width: 60, height: 200 }]
  const output = await PDFDocument.load(await exportAnnotatedPdf(source, [annotation], async () => asset))
  assert.equal(output.getPageCount(), 2)
  const outputContents = output.getPages()[0].node.lookup(PDFName.of('Contents'), PDFArray)
  assert(outputContents.asArray().some(reference => output.context.lookup(reference, PDFRawStream).getContentsString() === sourceContent))
  const native = output.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict)
  assert.equal(native.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'FreeText')
  assert.equal(native.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), annotation.text)
  assert.equal(native.lookup(PDFName.of('Rect'), PDFArray).toString(), '[ 95 495 165 705 ]')
  assert.equal(native.lookup(PDFName.of('Q'), PDFNumber).asNumber(), 1)
  assert.match(native.lookup(PDFName.of('DA'), PDFString).decodeText(), /^\/FT0 20 Tf 0\.0706 0\.3373 0\.6706 rg$/)
  const style = native.lookup(PDFName.of('DS'), PDFHexString).decodeText()
  for (const property of ['font-size:20pt', 'font-weight:bold', 'font-style:italic', 'text-decoration:underline', 'text-align:center', 'line-height:1.5']) assert(style.includes(property))
  const stream = appearance(native)
  assert.equal(stream.dict.lookup(PDFName.of('BBox'), PDFArray).toString(), '[ 0 0 70 210 ]')
  const commands = decoded(stream)
  assert.match(commands, /2 Tr/)
  assert.equal((commands.match(/> Tj/g) ?? []).length, 2)
  const face = fontkit.create(asset.bytes)
  const widths = annotation.textLines!.map(line => face.layout(line).glyphs.reduce((sum, glyph) => sum + glyph.advanceWidth, 0) * 20 / face.unitsPerEm)
  const transforms = matrices(commands)
  assert.equal(transforms.length, 2)
  for (let index = 0; index < 2; index++) {
    assert.deepEqual(transforms[index].slice(0, 4), [0, 1, -1, 0.2126])
    assert(Math.abs(transforms[index][4] - (22 + index * 30)) < 0.001)
    assert(Math.abs(transforms[index][5] - (200 - widths[index]) / 2 - 5) < 0.001)
  }
  assert.match(commands, /0\.9 w\n24 65 m 24 145 l S\n54 55 m 54 155 l S/)
  const resource = stream.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
  const font = resource.lookup(PDFName.of('FT0'), PDFDict)
  assert.equal(font.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'Type0')
  const unicode = decoded(font.lookup(PDFName.of('ToUnicode'), PDFRawStream))
  for (const character of '中文标题下一行文字') assert(unicode.toUpperCase().includes(character.codePointAt(0)!.toString(16).toUpperCase()))
  const descriptor = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('FontDescriptor'), PDFDict)
  const embeddedBytes = descriptor.lookup(PDFName.of('FontFile3'), PDFRawStream)
  assert(embeddedBytes.getContentsSize() > 100)
  // CID-keyed CFF fonts use a complete CFF program: fontkit corrupts their multi-dictionary subsets.
  assert.equal(embeddedBytes.dict.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'CIDFontType0C')
  assert(decoded(embeddedBytes).charCodeAt(0) === 1, 'the stream must contain a raw CFF program rather than an OTF container')
  const defaultResources = native.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
  assert.equal(defaultResources.get(PDFName.of('FT0'))?.toString(), resource.get(PDFName.of('FT0'))?.toString())
})

test('text export caches each font and respects left/right alignment and actual bold italic faces', async () => {
  const regular = await notoAsset()
  let resolutions = 0
  const annotations = [
    textAnnotation('left', '中文'),
    textAnnotation('right', '中文', { align: 'right' }),
    textAnnotation('real-face', '中文', { fontId: 'actual-bold-italic', bold: true, italic: true }),
  ]
  const output = await PDFDocument.load(await exportAnnotatedPdf(await sourcePdf(), annotations, async id => {
    resolutions++
    return id === regular.id ? regular : { ...regular, id, weight: 700, italic: true }
  }))
  assert.equal(resolutions, 2)
  const native = output.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
  const first = appearance(native.lookup(0, PDFDict))
  const second = appearance(native.lookup(1, PDFDict))
  const third = appearance(native.lookup(2, PDFDict))
  const fontReference = (stream: PDFRawStream, name: string) => stream.dict.lookup(PDFName.of('Resources'), PDFDict)
    .lookup(PDFName.of('Font'), PDFDict).get(PDFName.of(name))?.toString()
  assert.equal(fontReference(first, 'FT0'), fontReference(second, 'FT0'))
  assert.notEqual(fontReference(first, 'FT0'), fontReference(third, 'FT1'))
  assert.deepEqual(matrices(decoded(first))[0], [1, 0, 0, 1, 5, 48])
  assert.deepEqual(matrices(decoded(second))[0], [1, 0, 0, 1, 165, 48])
  assert.equal(native.lookup(0, PDFDict).lookup(PDFName.of('Q'), PDFNumber).asNumber(), 0)
  assert.equal(native.lookup(1, PDFDict).lookup(PDFName.of('Q'), PDFNumber).asNumber(), 2)
  assert.match(decoded(third), /0 Tr/)
  assert(!decoded(third).includes('2 Tr'), 'a real bold face must not be stroked a second time')
  assert.deepEqual(matrices(decoded(third))[0].slice(0, 4), [1, 0, 0, 1], 'a real italic face must not receive another skew')
})

test('missing glyphs produce a useful font error while nontext markup never resolves a font', async () => {
  const asset = await notoAsset()
  const source = await sourcePdf()
  await assert.rejects(exportAnnotatedPdf(source, [textAnnotation('unsupported', '中文\u{10ffff}')], async () => asset), /Noto Sans CJK SC Regular.*不包含字符.*U\+10FFFF/)
  const highlight: Annotation = { id: 'highlight', kind: 'highlight', page: 1, color: '#f5cd52', text: 'Original text', comment: '', rects: [{ x: 40, y: 730, width: 100, height: 14 }], createdAt: 0 }
  const output = await PDFDocument.load(await exportAnnotatedPdf(source, [highlight], async () => { throw new Error('No font files available') }))
  const native = output.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).lookup(0, PDFDict)
  assert.equal(native.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'Highlight')
})

test('text export embeds the selected local TTC face rather than the first collection face', async context => {
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await readFile('/System/Library/Fonts/STHeiti Light.ttc')) } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') { context.skip('This platform does not include the macOS TTC fixture.'); return }
    throw error
  }
  const assets: Record<string, FontAsset> = Object.fromEntries(['STHeitiSC-Light', 'STHeitiTC-Light'].map(name => [name, {
    id: name, bytes, family: name.startsWith('STHeitiSC') ? '黑体-简' : '黑体-繁', fullName: name,
    postscriptName: name, style: 'Light', weight: 300, italic: false, source: 'system' as const,
  }]))
  const annotations = Object.keys(assets).map((id, index) => textAnnotation(`collection-${index}`, '中文字体测试', { fontId: id, fontFamily: assets[id].family }))
  const output = await PDFDocument.load(await exportAnnotatedPdf(await sourcePdf(), annotations, async id => assets[id]))
  const native = output.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
  for (const [index, name] of Object.keys(assets).entries()) {
    const resources = appearance(native.lookup(index, PDFDict)).dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
    const font = resources.lookup(PDFName.of(`FT${index}`), PDFDict)
    assert(font.lookup(PDFName.of('BaseFont'), PDFName).decodeText().startsWith(name))
    assert(decoded(font.lookup(PDFName.of('ToUnicode'), PDFRawStream)).includes('4E2D'))
    const descriptor = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict).lookup(PDFName.of('FontDescriptor'), PDFDict)
    assert(descriptor.lookup(PDFName.of('FontFile2'), PDFRawStream).getContentsSize() < bytes.length / 10, 'TrueType collection faces should still be subset')
    assert(native.lookup(index, PDFDict).lookup(PDFName.of('DS'), PDFHexString).decodeText().includes(assets[name].family))
  }
})
