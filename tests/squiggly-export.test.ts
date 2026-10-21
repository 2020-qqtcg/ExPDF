import assert from 'node:assert/strict'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, StandardFonts, degrees } from 'pdf-lib'
import { exportAnnotatedPdf } from '../src/lib/export.ts'
import { SQUIGGLY_STROKE_WIDTH, TEXT_MARKUP_STROKE_WIDTH, squigglyPath } from '../src/lib/markup.ts'
import { ANNOTATION_LABELS } from '../src/types.ts'
import type { Annotation } from '../src/types.ts'

test('Squiggly export preserves source content and writes native multiline quads with a visible curved appearance', async () => {
  const source = await PDFDocument.create()
  const page = source.addPage([600, 800])
  page.setCropBox(20, 40, 500, 680)
  page.setRotation(degrees(90))
  const font = await source.embedFont(StandardFonts.Helvetica)
  page.drawText('Selectable original text remains intact.', { x: 40, y: 620, size: 12, font })
  page.node.addAnnot(source.context.register(source.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [200, 200, 220, 220], Contents: PDFHexString.fromText('Existing source note'),
  })))
  const originalBytes = await source.save()
  const original = await PDFDocument.load(originalBytes)
  const originalStream = original.getPages()[0].node.lookup(PDFName.of('Contents'), PDFArray).lookup(0, PDFRawStream).getContentsString()
  const annotation: Annotation = {
    id: 'squiggly-中文', kind: 'squiggly', page: 1, color: '#8a64d9', text: 'Selected text across two lines', comment: '波浪线：需要进一步确认。',
    rects: [{ x: 40, y: 620, width: 132, height: 14 }, { x: 40, y: 600, width: 100.8, height: 12 }], createdAt: 1_700_000_000_000,
  }
  const output = await PDFDocument.load(await exportAnnotatedPdf(originalBytes, [annotation], async () => { throw new Error('Markup must not require font access') }))
  const resultPage = output.getPages()[0]
  assert.deepEqual(resultPage.getCropBox(), { x: 20, y: 40, width: 500, height: 680 })
  assert.equal(resultPage.getRotation().angle, 90)
  const contents = resultPage.node.lookup(PDFName.of('Contents'), PDFArray)
  assert(contents.asArray().some(reference => output.context.lookup(reference, PDFRawStream).getContentsString() === originalStream))
  const annotations = resultPage.node.lookup(PDFName.of('Annots'), PDFArray)
  assert.equal(annotations.size(), 2)
  assert.equal(annotations.lookup(0, PDFDict).lookup(PDFName.of('Contents'), PDFHexString).decodeText(), 'Existing source note')
  const native = annotations.lookup(1, PDFDict)
  assert.equal(native.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'Squiggly')
  assert.equal(native.lookup(PDFName.of('NM'), PDFHexString).decodeText(), annotation.id)
  assert.equal(native.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), annotation.comment)
  assert.equal(native.lookup(PDFName.of('F'), PDFNumber).asNumber(), 4)
  assert.equal(native.lookup(PDFName.of('Rect'), PDFArray).toString(), '[ 38.5 598.5 173.5 635.5 ]')
  assert.equal(native.lookup(PDFName.of('QuadPoints'), PDFArray).toString(), '[ 40 634 172 634 40 620 172 620 40 612 140.8 612 40 600 140.8 600 ]')
  const appearance = native.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream)
  assert.equal(appearance.dict.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'Form')
  assert.equal(appearance.dict.lookup(PDFName.of('BBox'), PDFArray).toString(), '[ 0 0 135 37 ]')
  const commands = inflateSync(appearance.getContents()).toString('utf8')
  assert.match(commands, /0\.8 w\n1 J\n1 j/)
  assert.match(commands, /1\.5 22\.34 m/)
  assert.match(commands, /1\.5 2\.3 m/)
  assert.equal((commands.match(/ m\n/g) ?? []).length, 2)
  assert.equal((commands.match(/^S$/gm) ?? []).length, 2)
  assert((commands.match(/ c\n/g) ?? []).length > 100, 'Each selected line needs actual wave curves')
  assert.equal(ANNOTATION_LABELS.squiggly, '波浪线')
})

test('shared squiggly geometry uses native coordinates and keeps a complete wave and short partial wave within padded bounds', () => {
  const rect = { x: 100, y: 500, width: 4.8, height: 16 }
  const wave = squigglyPath(rect)
  assert.equal(SQUIGGLY_STROKE_WIDTH, 0.8)
  assert.equal(TEXT_MARKUP_STROKE_WIDTH, 0.8)
  assert.deepEqual(wave.start, { x: 100, y: 500.96 })
  assert.equal(wave.curves.length, 4)
  assert(Math.abs(wave.curves[0].end.y - (wave.start.y + 0.8)) < 0.00001)
  assert(Math.abs(wave.curves[2].end.y - (wave.start.y - 0.8)) < 0.00001)
  assert(Math.abs(wave.curves[3].end.x - 104.8) < 0.00001)
  assert(Math.abs(wave.curves[3].end.y - wave.start.y) < 0.00001)
  const tiny = { x: 30, y: 50, width: 0.3, height: 0.01 }
  const partial = squigglyPath(tiny)
  assert.equal(partial.curves.length, 1)
  assert.equal(partial.curves[0].end.x, 30.3)
  assert(partial.curves[0].end.y > partial.start.y, 'A partial wave must continue its phase rather than flatten')
  for (const curve of partial.curves) for (const point of [curve.control1, curve.control2, curve.end]) {
    assert(point.x >= tiny.x && point.x <= tiny.x + tiny.width)
    assert(point.y - SQUIGGLY_STROKE_WIDTH / 2 >= tiny.y - 1.5)
    assert(point.y + SQUIGGLY_STROKE_WIDTH / 2 <= tiny.y + tiny.height + 1.5)
  }
})

test('Underline and StrikeOut appearances use the shared 0.8pt markup width', async () => {
  const source = await PDFDocument.create()
  source.addPage([300, 400])
  const annotations: Annotation[] = (['underline', 'strikeout'] as const).map(kind => ({
    id: kind, kind, page: 1, color: '#8a64d9', rects: [{ x: 30, y: 100, width: 100, height: 16 }], text: 'Selected text', comment: '', createdAt: 1_700_000_000_000,
  }))
  const output = await PDFDocument.load(await exportAnnotatedPdf(await source.save(), annotations))
  const native = output.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
  assert.equal(native.size(), 2)
  for (let index = 0; index < native.size(); index++) {
    const appearance = native.lookup(index, PDFDict).lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream)
    assert.match(inflateSync(appearance.getContents()).toString('utf8'), /0\.8 w\n1 J/)
  }
})
