import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream } from 'pdf-lib'
import localFontsPlugin from '../server/fonts.mjs'
import { exportAnnotatedPdf } from '../src/lib/export.ts'
import type { Annotation, FontAsset, FontDescriptor } from '../src/types.ts'

test('exports real PingFang and Kaiti Chinese faces, including an unparsed CFF FontDict', { skip: process.platform !== 'darwin', timeout: 120_000 }, async context => {
  // Exercise the same font metadata/bytes endpoint used by the reader, without
  // requiring an already running development server or redistributing OS fonts.
  let middleware: (request: IncomingMessage, response: ServerResponse, next: () => void) => unknown
  localFontsPlugin().configureServer({ middlewares: { use(handler: typeof middleware) { middleware = handler } } })
  const server = createServer((request, response) => {
    void middleware(request, response, () => { response.writeHead(404); response.end() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  try {
    const address = server.address()
    assert(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    const descriptors: FontDescriptor[] = await (await fetch(`${base}/api/fonts`)).json()
    const selected = [
      descriptors.find(font => font.postscriptName === 'PingFangSC-Regular'),
      descriptors.find(font => ['STKaitiSC-Regular', 'KaitiSC-Regular'].includes(font.postscriptName)),
    ]
    if (selected.some(font => !font)) { context.skip('These downloadable macOS Chinese faces are not installed.'); return }
    const fonts = selected as FontDescriptor[]
    const assets = new Map<string, FontAsset>()
    for (const font of fonts) {
      const response = await fetch(`${base}/api/fonts/${font.id}`)
      assert(response.ok)
      assets.set(font.id, { ...font, bytes: new Uint8Array(await response.arrayBuffer()) })
    }
    const source = await PDFDocument.create()
    source.addPage([612, 792])
    const lines = ['苹方中文：字体导出测试', '楷体中文：字体导出测试']
    const annotations: Annotation[] = fonts.map((font, index) => ({
      id: `chinese-font-${index}`, page: 1, kind: 'text', color: '#333333',
      text: lines[index], textLines: [lines[index]], comment: '', createdAt: 1_700_000_000_000,
      points: [{ x: 60, y: 680 - index * 180 }],
      rects: [{ x: 60, y: 640 - index * 180, width: 450, height: 40 }],
      textStyle: {
        fontId: font.id, fontFamily: font.family, fontName: font.fullName,
        fontSize: 26, bold: false, italic: false, underline: false,
        align: 'left', lineHeight: 1.4, width: 450, rotation: 0,
      },
    }))
    const bytes = await exportAnnotatedPdf(await source.save(), annotations, async id => {
      const font = assets.get(id)
      assert(font)
      return font
    })
    const output = await PDFDocument.load(bytes)
    const annots = output.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray)
    assert.equal(annots.size(), 2)
    for (const [index, expected] of fonts.entries()) {
      const annotation = annots.lookup(index, PDFDict)
      assert.equal(annotation.lookup(PDFName.of('Subtype'), PDFName).decodeText(), 'FreeText')
      assert.equal(annotation.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), lines[index])
      const appearance = annotation.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'), PDFRawStream)
      const resources = appearance.dict.lookup(PDFName.of('Resources'), PDFDict).lookup(PDFName.of('Font'), PDFDict)
      const font = resources.lookup(PDFName.of(`FT${index}`), PDFDict)
      assert(font.lookup(PDFName.of('BaseFont'), PDFName).decodeText().startsWith(expected.postscriptName))
      const descendant = font.lookup(PDFName.of('DescendantFonts'), PDFArray).lookup(0, PDFDict)
      const descriptor = descendant.lookup(PDFName.of('FontDescriptor'), PDFDict)
      const program = descriptor.lookup(PDFName.of(index === 0 ? 'FontFile3' : 'FontFile2'), PDFRawStream)
      assert(program.getContentsSize() > 100)
    }
    const extracted = spawnSync('pdftotext', ['-', '-'], { input: bytes, encoding: 'utf8' })
    if (extracted.error?.code === 'ENOENT') context.diagnostic('Poppler is unavailable; embedded font and native annotation checks passed.')
    else {
      assert.equal(extracted.status, 0, extracted.stderr)
      for (const line of lines) assert(extracted.stdout.includes(line))
      const rendered = spawnSync('pdftoppm', ['-f', '1', '-singlefile', '-scale-to', '1200', '-png', '-'], { input: bytes, maxBuffer: 4 * 1024 * 1024 })
      assert.equal(rendered.status, 0, rendered.stderr.toString())
      assert.equal(rendered.stdout.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
      server.closeAllConnections()
    })
  }
})
