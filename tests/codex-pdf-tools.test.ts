import assert from 'node:assert/strict'
import test from 'node:test'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import { PDF_DYNAMIC_TOOLS, isPdfTool } from '../server/codex-pdf-tools.mjs'
import { createPdfToolDispatcher } from '../src/lib/codex-pdf-tools.ts'
import type { PdfToolDocument, PdfToolResult } from '../src/lib/codex-pdf-tools.ts'
import type { Annotation } from '../src/types.ts'

function fixture(texts = ['First page', 'Second page']) {
  let reads = 0
  const pdf = { numPages: texts.length, getPage: async (number: number) => ({
    view: [20, 40, 520, 740],
    getTextContent: async () => {
      reads++
      return { items: texts[number - 1].split('\n').map((str, index, lines) => ({ str, hasEOL: index < lines.length - 1, transform: [12, 0, 0, 12, 30, 700], width: str.length * 6, height: 12, dir: 'ltr', fontName: 'F1' })), styles: {}, lang: 'en' }
    },
  }) } as unknown as PDFDocumentProxy
  let current: PdfToolDocument | null = { id: 'fixture', name: 'fixture.pdf', pdf }
  const annotations: Annotation[] = []
  const navigated: number[] = []
  const dispatch = createPdfToolDispatcher({ getDocument: () => current, getCurrentPage: () => 2, getAnnotations: () => annotations, onNavigate: number => navigated.push(number), onAddAnnotation: annotation => annotations.push(annotation) })
  return { dispatch, pdf, annotations, navigated, reads: () => reads, setDocument: (value: PdfToolDocument | null) => { current = value } }
}
function ok(result: PdfToolResult) { assert.equal(result.ok, true, JSON.stringify(result)); return result as Extract<PdfToolResult, { ok: true }> }
function code(result: PdfToolResult, expected: string) { assert.equal(result.ok, false); if (!result.ok) assert.equal(result.error.code, expected) }
const tool = (name: string) => `folio_pdf_${name}`

test('shared registration contains exactly seven strictly scoped PDF function tools', () => {
  assert.equal(PDF_DYNAMIC_TOOLS.length, 7)
  assert.equal(new Set(PDF_DYNAMIC_TOOLS.map(item => item.name)).size, 7)
  for (const item of PDF_DYNAMIC_TOOLS) {
    assert.equal(item.type, 'function')
    assert.equal(item.inputSchema.additionalProperties, false)
    assert(isPdfTool(item.name))
  }
  for (const name of ['exec', 'computer', 'folio_pdf_delete_file', 'folio_pdf_', null]) assert(!isPdfTool(name))
})

test('reads long pages with resumable character budgets and preserves page boundaries', async () => {
  const text = 'ABCD'.repeat(90)
  const f = fixture([text, 'Next page'])
  const collected: string[] = []
  let args: Record<string, unknown> | null = { startPage: 1, endPage: 2, maxChars: 100 }
  while (args) {
    const result = ok(await f.dispatch(tool('read_pages'), args))
    const pages = result.pages as { page: number; text: string; offset: number; endOffset: number }[]
    assert(pages.reduce((sum, page) => sum + page.text.length, 0) <= 100)
    collected.push(...pages.map(page => page.text))
    args = result.nextCursor ? { ...result.nextCursor as object, maxChars: 100 } : null
  }
  assert.equal(collected.join(''), `${text}Next page`)
  assert.equal(f.reads(), 2, 'continuations reuse text rather than extracting it again')
  const empty = ok(await f.dispatch(tool('read_pages'), { startPage: 1, offset: text.length }))
  assert.equal((empty.pages as { text: string }[])[0].text, '')
  assert.equal(empty.nextCursor, null)
})

test('search is literal, crosses line breaks, paginates occurrences and does not modify annotations', async () => {
  const f = fixture(['a.b ab a.b\nHello\nworld', 'HELLO world'])
  const first = ok(await f.dispatch(tool('search'), { query: 'a.b', limit: 1 }))
  assert.deepEqual((first.matches as { text: string; offset: number }[]).map(item => [item.text, item.offset]), [['a.b', 0]])
  const next = ok(await f.dispatch(tool('search'), { query: 'a.b', ...first.nextCursor as object }))
  assert.equal((next.matches as unknown[]).length, 1)
  const across = ok(await f.dispatch(tool('search'), { query: 'hello world' }))
  assert.deepEqual((across.matches as { page: number }[]).map(item => item.page), [1, 2])
  assert.equal((ok(await f.dispatch(tool('search'), { query: 'HELLO world', caseSensitive: true })).matches as unknown[]).length, 1)
  assert.equal(f.annotations.length, 0)
})

test('notes use the current crop box and one App write callback without requiring text/OCR', async () => {
  const f = fixture()
  f.pdf.getPage = async () => ({ view: [-10, 30, 60, 90], getTextContent: async () => { throw Error('Do not extract text for an unattached note') } }) as unknown as PDFPageProxy
  const result = ok(await f.dispatch(tool('add_note'), { page: 2, comment: ' 中文便签 ', color: '#123abc' }))
  assert.equal(result.kind, 'note')
  assert.equal(f.annotations.length, 1)
  const note = f.annotations[0]
  assert.equal(note.comment, '中文便签')
  assert.equal(note.text, '')
  assert.equal(note.color, '#123abc')
  assert.deepEqual(note.rects, [{ x: 24, y: 54, width: 24, height: 24 }])
  assert.equal(f.reads(), 0)
  ok(await f.dispatch(tool('navigate_page'), { page: 2 }))
  assert.deepEqual(f.navigated, [2])
  assert.equal(ok(await f.dispatch(tool('get_document'), {})).annotationCount, 1)
  const listed = ok(await f.dispatch(tool('list_annotations'), { kind: 'note', page: 2, limit: 1 }))
  assert.equal((listed.annotations as Annotation[])[0].comment, '中文便签')
})

test('rejects unknown properties, unsafe ranges, oversize payloads and ambiguous highlights before mutation', async () => {
  const f = fixture(['Same phrase. Same phrase.', 'Other', '3', '4', '5', '6'])
  const invalid: [string, unknown][] = [
    ['get_document', { path: '/tmp/other.pdf' }], ['read_pages', { startPage: 0 }], ['read_pages', { startPage: 1, endPage: 6 }],
    ['read_pages', { startPage: 1, maxChars: 20_001 }], ['navigate_page', { page: 1.5 }], ['navigate_page', { page: 7 }],
    ['add_note', { page: 1, comment: ' ' }], ['add_note', { page: 1, comment: 'x'.repeat(5001) }], ['add_note', { page: 1, comment: 'ok', occurrence: 2 }],
    ['search', { query: ' ' }], ['search', { query: 'x', limit: 51 }], ['search', { query: 'x', caseSensitive: 'false' }],
    ['highlight_text', { page: 1, text: 'Same', color: 'red' }], ['list_annotations', { kind: 'delete' }],
  ]
  for (const [name, args] of invalid) code(await f.dispatch(tool(name), args), 'INVALID_ARGUMENTS')
  code(await f.dispatch('desktop_click', {}), 'UNKNOWN_TOOL')
  code(await f.dispatch(tool('get_document'), []), 'INVALID_ARGUMENTS')
  code(await f.dispatch(tool('highlight_text'), { page: 1, text: 'Same phrase.' }), 'AMBIGUOUS_TEXT')
  code(await f.dispatch(tool('highlight_text'), { page: 1, text: 'missing' }), 'TEXT_NOT_FOUND')
  assert.equal(f.annotations.length, 0)
  assert.equal(f.navigated.length, 0)
})

test('document identity and cancellation are checked after awaits, before writes, and on cached reads', async () => {
  const f = fixture()
  let release!: (page: PDFPageProxy) => void
  const page = await f.pdf.getPage(1)
  f.pdf.getPage = () => new Promise(resolve => { release = resolve })
  const pending = f.dispatch(tool('add_note'), { page: 1, comment: 'stale' })
  f.setDocument({ id: 'different', name: 'new.pdf', pdf: f.pdf })
  release(page)
  code(await pending, 'DOCUMENT_CHANGED')
  assert.equal(f.annotations.length, 0)
  code(await f.dispatch(tool('navigate_page'), { page: 1 }, { documentId: 'fixture' }), 'DOCUMENT_CHANGED')
  const controller = new AbortController()
  const canceled = f.dispatch(tool('add_note'), { page: 1, comment: 'canceled' }, { signal: controller.signal })
  controller.abort(); release(page)
  code(await canceled, 'CANCELED')
  assert.equal(f.annotations.length, 0)
  f.pdf.getPage = async () => page
  ok(await f.dispatch(tool('read_pages'), { startPage: 1 }))
  code(await f.dispatch(tool('read_pages'), { startPage: 1 }, { signal: controller.signal }), 'CANCELED')
  f.setDocument(null)
  code(await f.dispatch(tool('get_document'), {}), 'NO_DOCUMENT')
})
