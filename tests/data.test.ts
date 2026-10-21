import assert from 'node:assert/strict'
import test from 'node:test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRawStream, StandardFonts, degrees } from 'pdf-lib'
import { createDemoDocument } from '../src/lib/demo.ts'
import { exportAnnotatedPdf } from '../src/lib/export.ts'
import { getDocumentId } from '../src/lib/storage.ts'
import type { Annotation } from '../src/types.ts'

test('demo is a real four-page PDF and all demo annotation rectangles fit their pages', async () => {
  const demo = await createDemoDocument()
  const document = await PDFDocument.load(demo.bytes)
  assert.equal(document.getPageCount(), 4)
  assert.equal(document.getTitle(), 'The art of paying attention')
  assert.equal(demo.annotations.length, 3)
  assert.deepEqual(demo.annotations.map((annotation) => annotation.kind), ['highlight', 'highlight', 'note'])
  for (const annotation of demo.annotations) {
    const { width, height } = document.getPages()[annotation.page - 1].getSize()
    for (const rect of annotation.rects) {
      assert(rect.x >= 0 && rect.x + rect.width <= width)
      assert(rect.y >= 0 && rect.y + rect.height <= height)
    }
  }
  assert(document.getPages()[0].node.Contents())
})

test('export keeps source geometry and original annotations, and writes editable native Unicode markup with appearances', async () => {
  const source = await PDFDocument.create()
  const page = source.addPage([600, 800])
  page.setCropBox(20, 40, 500, 680)
  page.setRotation(degrees(90))
  const font = await source.embedFont(StandardFonts.Helvetica)
  page.drawText('Original selectable PDF text', { x: 60, y: 620, font })
  const original = source.context.register(source.context.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [100, 100, 120, 120], Contents: PDFHexString.fromText('Existing note'),
  }))
  page.node.addAnnot(original)
  const sourceBytes = await source.save()
  const savedSource = await PDFDocument.load(sourceBytes)
  const originalContentReference = (savedSource.getPages()[0].node.Contents() as PDFArray).get(0)
  const originalContent = savedSource.context.lookup(originalContentReference, PDFRawStream).getContentsString()
  const annotationBase = {
    page: 1, color: '#f5cd52', text: 'Selected text', comment: '中文便签：值得再读。',
    rects: [{ x: 60, y: 600, width: 160, height: 16 }], createdAt: 1_700_000_000_000,
  }
  const annotations: Annotation[] = (['highlight', 'underline', 'strikeout', 'note', 'draw'] as const).map((kind, index) => ({
    ...annotationBase, id: `test-${index}`, kind,
    ...(kind === 'draw' ? { points: [{ x: 80, y: 500 }, { x: 110, y: 525 }, { x: 150, y: 510 }] } : {}),
  }))
  const bytes = await exportAnnotatedPdf(sourceBytes, annotations)
  const output = await PDFDocument.load(bytes)
  const outputPage = output.getPages()[0]
  assert.deepEqual(outputPage.getCropBox(), { x: 20, y: 40, width: 500, height: 680 })
  assert.equal(outputPage.getRotation().angle, 90)
  assert((outputPage.node.Contents() as PDFArray).asArray().some((reference) => reference.toString() === originalContentReference.toString()))
  assert.equal(output.context.lookup(originalContentReference, PDFRawStream).getContentsString(), originalContent)
  const annots = outputPage.node.lookup(PDFName.of('Annots'), PDFArray)
  assert.equal(annots.size(), 6)
  const first = annots.lookup(0, PDFDict)
  assert.equal(first.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), 'Existing note')
  const subtypes = ['Highlight', 'Underline', 'StrikeOut', 'Text', 'Ink']
  for (let index = 0; index < annotations.length; index++) {
    const annotation = annots.lookup(index + 1, PDFDict)
    assert.equal(annotation.lookup(PDFName.of('Subtype'), PDFName).decodeText(), subtypes[index])
    assert.equal(annotation.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), '中文便签：值得再读。')
    assert.equal(annotation.lookup(PDFName.of('NM'), PDFHexString).decodeText(), `test-${index}`)
    const appearance = annotation.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream)
    assert(appearance.getContentsSize() > 10)
    assert.equal(annotation.lookup(PDFName.of('F'), PDFNumber).asNumber(), 4)
  }
  const highlight = annots.lookup(1, PDFDict)
  assert.equal(highlight.lookup(PDFName.of('Rect'), PDFArray).toString(), '[ 60 600 220 616 ]')
  assert.equal(highlight.lookup(PDFName.of('QuadPoints'), PDFArray).toString(), '[ 60 616 220 616 60 600 220 600 ]')
  const ink = annots.lookup(5, PDFDict)
  assert.equal(ink.lookup(PDFName.of('InkList'), PDFArray).toString(), '[ [ 80 500 110 525 150 510 ] ]')
})

test('document IDs are stable SHA-256 values and distinguish different PDFs', async () => {
  assert.equal(await getDocumentId(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.notEqual(await getDocumentId(new Uint8Array([1, 2])), await getDocumentId(new Uint8Array([1, 3])))
})
