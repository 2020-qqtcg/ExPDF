import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist'
import type { TextContent, TextItem } from 'pdfjs-dist/types/src/display/api'
import { PDF_DYNAMIC_TOOLS, PDF_TOOL_LIMITS, PDF_TOOL_PREFIX, isPdfTool } from '../../server/codex-pdf-tools.mjs'
import type { Annotation, PdfRect } from '../types'
import { mergeSelectionRects } from './pdf-selection'

export interface PdfToolDocument { id: string; name: string; pdf: PDFDocumentProxy }
export interface PdfToolBindings {
  getDocument: () => PdfToolDocument | null
  getCurrentPage: () => number
  getAnnotations: () => readonly Annotation[]
  onNavigate: (page: number) => void
  onAddAnnotation: (annotation: Annotation) => void
  onNotify?: (message: string) => void
}
export interface PdfToolCallOptions { documentId?: string; signal?: AbortSignal }
export type PdfToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: { code: string; message: string; details?: unknown } }
type Args = Record<string, unknown>
interface TextSpan { item: TextItem; start: number; end: number }
interface PageText { page: PDFPageProxy; content: TextContent; text: string; spans: TextSpan[] }
interface TextMatch { start: number; end: number }
type Check = () => void

class PdfToolError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) { super(message) }
}
function invalid(message: string): never { throw new PdfToolError('INVALID_ARGUMENTS', message) }
function validate(tool: string, value: unknown): Args {
  if (!isPdfTool(tool)) throw new PdfToolError('UNKNOWN_TOOL', '未知 PDF 工具。')
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('工具参数必须是 JSON 对象。')
  const args = value as Args
  const schema = PDF_DYNAMIC_TOOLS.find(item => item.name === tool)!.inputSchema
  for (const key of schema.required) if (!Object.hasOwn(args, key)) invalid(`缺少参数 ${key}。`)
  for (const [key, input] of Object.entries(args)) {
    if (!Object.hasOwn(schema.properties, key)) invalid(`不支持参数 ${key}。`)
    const rule = schema.properties[key] as { type: string; minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; enum?: string[] }
    if (rule.type === 'integer' && (!Number.isSafeInteger(input) || (input as number) < rule.minimum! || (input as number) > rule.maximum!)) invalid(`${key} 必须是 ${rule.minimum}–${rule.maximum} 范围内的整数。`)
    if (rule.type === 'boolean' && typeof input !== 'boolean') invalid(`${key} 必须是布尔值。`)
    if (rule.type === 'string') {
      if (typeof input !== 'string' || !input.trim() || input.length < (rule.minLength ?? 0) || input.length > (rule.maxLength ?? Infinity)) invalid(`${key} 为空、类型不正确或超过长度限制。`)
      if (rule.pattern && !new RegExp(rule.pattern).test(input as string)) invalid(`${key} 格式不正确。`)
      if (rule.enum && !rule.enum.includes(input as string)) invalid(`${key} 不在支持的值中。`)
    }
  }
  return args
}
function pageNumber(input: unknown, document: PdfToolDocument) {
  const value = input as number
  if (!Number.isSafeInteger(value) || value < 1 || value > document.pdf.numPages) invalid(`页码必须在 1–${document.pdf.numPages} 范围内。`)
  return value
}
function literalPattern(query: string, caseSensitive = false) {
  const source = query.trim().split(/\s+/u).map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  return new RegExp(source, caseSensitive ? 'gu' : 'giu')
}
function excerpt(text: string, match: TextMatch) {
  const start = Math.max(0, match.start - 90), end = Math.min(text.length, match.end + 110)
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}
function quoteMatch(model: PageText, quote: string, occurrence?: number) {
  const pattern = literalPattern(quote)
  const matches: TextMatch[] = []
  let match: RegExpExecArray | null
  while (matches.length < 101 && (match = pattern.exec(model.text))) matches.push({ start: match.index, end: match.index + match[0].length })
  if (!matches.length) throw new PdfToolError('TEXT_NOT_FOUND', '这一页没有找到该文字，请先读取或搜索原文；扫描页需要可选择的文字。')
  if (matches.length > 1 && occurrence === undefined) throw new PdfToolError('AMBIGUOUS_TEXT', '这段文字在本页出现多次，请用 occurrence 指定第几处。', { matchCountAtLeast: matches.length, matches: matches.slice(0, 5).map((item, index) => ({ occurrence: index + 1, excerpt: excerpt(model.text, item) })) })
  const selected = matches[(occurrence ?? 1) - 1]
  if (!selected) throw new PdfToolError('TEXT_NOT_FOUND', `没有第 ${occurrence} 处匹配文字。`, { matchCount: matches.length })
  return selected
}

/** Use the same PDF.js selectable-text geometry as the reader, without touching its selection. */
async function measureMatch(model: PageText, match: TextMatch, check: Check): Promise<PdfRect[]> {
  if (typeof document === 'undefined') throw new PdfToolError('TEXT_GEOMETRY_UNAVAILABLE', '文字标注需要在 PDF 阅读器中执行。')
  const { TextLayer } = await import('pdfjs-dist')
  check()
  // Rotation zero gives native page axes; convertToPdfPoint also handles CropBox/UserUnit.
  const viewport = model.page.getViewport({ scale: 2, rotation: 0 })
  const effectiveScale = viewport.scale * viewport.userUnit
  const host = document.createElement('div')
  host.setAttribute('aria-hidden', 'true')
  host.inert = true
  Object.assign(host.style, { position: 'fixed', left: '-100000px', top: '0', width: `${viewport.width}px`, height: `${viewport.height}px`, opacity: '0', pointerEvents: 'none', zIndex: '-1' })
  const container = document.createElement('div')
  Object.assign(container.style, { position: 'absolute', inset: '0', width: `${viewport.width}px`, height: `${viewport.height}px`, lineHeight: '1', letterSpacing: 'normal', wordSpacing: 'normal', textSizeAdjust: 'none', transformOrigin: '0 0' })
  container.style.setProperty('--total-scale-factor', String(effectiveScale))
  container.style.setProperty('--scale-round-x', '1px')
  container.style.setProperty('--scale-round-y', '1px')
  host.append(container)
  document.body.append(host)
  let layer: InstanceType<typeof TextLayer> | undefined
  try {
    layer = new TextLayer({ textContentSource: model.content, container, viewport })
    await layer.render()
    check()
    const minimum = container.style.getPropertyValue('--min-font-size') || '1'
    // These are PDF.js text-layer rules, applied locally so this helper is independent of page CSS.
    for (const div of layer.textDivs) Object.assign(div.style, {
      position: 'absolute', whiteSpace: 'pre', transformOrigin: '0 0',
      fontSize: `calc(${effectiveScale} * ${minimum} * var(--font-height))`,
      transform: `rotate(var(--rotate, 0deg)) scaleX(var(--scale-x, 1)) scale(${1 / Number(minimum)})`,
    })
    // Lazy font loading can finish between PDF.js's canvas measurement and DOM layout.
    // Reconcile the final browser font against the source item's actual advance width.
    container.getBoundingClientRect()
    await document.fonts.ready
    check()
    for (let index = 0; index < model.spans.length; index++) {
      const span = model.spans[index], div = layer.textDivs[index]
      if (!div || !span.item.str || span.end <= match.start || span.start >= match.end) continue
      const transform = div.style.transform
      div.style.transform = 'none'
      const measured = div.getBoundingClientRect().width
      div.style.transform = transform
      const advance = model.content.styles[span.item.fontName]?.vertical ? span.item.height : span.item.width
      if (measured > 0 && advance > 0) div.style.setProperty('--scale-x', String(advance * effectiveScale * Number(minimum) / measured))
    }
    const bounds = container.getBoundingClientRect()
    const raw: PdfRect[] = []
    for (let index = 0; index < model.spans.length; index++) {
      const span = model.spans[index]
      if (span.end <= match.start || span.start >= match.end || !span.item.str) continue
      const node = layer.textDivs[index]?.firstChild
      if (!node || node.nodeType !== Node.TEXT_NODE) continue
      const range = document.createRange()
      range.setStart(node, Math.max(0, match.start - span.start))
      range.setEnd(node, Math.min(span.item.str.length, match.end - span.start))
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue
        const corners = [[rect.left, rect.top], [rect.right, rect.top], [rect.left, rect.bottom], [rect.right, rect.bottom]]
          .map(([x, y]) => viewport.convertToPdfPoint(x - bounds.left, y - bounds.top))
        const x = Math.min(...corners.map(point => point[0])), y = Math.min(...corners.map(point => point[1]))
        raw.push({ x, y, width: Math.max(...corners.map(point => point[0])) - x, height: Math.max(...corners.map(point => point[1])) - y })
      }
    }
    const [left, bottom, right, top] = model.page.view
    const rects = mergeSelectionRects(raw).map(rect => {
      const x = Math.max(left, rect.x), y = Math.max(bottom, rect.y)
      return { x, y, width: Math.min(right, rect.x + rect.width) - x, height: Math.min(top, rect.y + rect.height) - y }
    }).filter(rect => Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0)
    if (!rects.length) throw new PdfToolError('TEXT_GEOMETRY_UNAVAILABLE', '找到文字，但无法取得可见文字范围；没有添加标注。')
    check()
    return rects
  } finally { layer?.cancel(); host.remove() }
}

/** Bind once to live App refs. A call never retains authority over a different document. */
export function createPdfToolDispatcher(bindings: PdfToolBindings) {
  let cachedDocument: PdfToolDocument | null = null
  const cache = new Map<number, PageText>()
  return async function dispatchPdfTool(tool: string, input: unknown, options: PdfToolCallOptions = {}): Promise<PdfToolResult> {
    try {
      const args = validate(tool, input)
      const document = bindings.getDocument()
      if (!document) throw new PdfToolError('NO_DOCUMENT', '当前没有打开 PDF。')
      const check = () => {
        if (options.signal?.aborted) throw new PdfToolError('CANCELED', '工具调用已取消。')
        const current = bindings.getDocument()
        if (!current || current.id !== document.id || current.pdf !== document.pdf || (options.documentId !== undefined && options.documentId !== current.id)) throw new PdfToolError('DOCUMENT_CHANGED', '当前 PDF 已切换，请针对新文档重新发起工具调用。')
      }
      check()
      if (cachedDocument?.id !== document.id || cachedDocument.pdf !== document.pdf) { cache.clear(); cachedDocument = document }
      const loadPage = async (number: number) => {
        check()
        let model = cache.get(number)
        if (!model) {
          const page = await document.pdf.getPage(number)
          check()
          const content = await page.getTextContent()
          check()
          let text = ''
          const spans: TextSpan[] = []
          for (const item of content.items) {
            if (!('str' in item)) continue
            const start = text.length
            text += item.str
            spans.push({ item, start, end: text.length })
            if (item.hasEOL) text += '\n'
            if (text.length > 20_000_000) throw new PdfToolError('PAGE_TEXT_TOO_LARGE', '这一页文字过多，无法安全处理。')
          }
          model = { page, content, text, spans }
          if (text.length <= 500_000) cache.set(number, model)
          // Bound retained text/items while walking a large document.
          if (cache.size > 12) cache.delete(cache.keys().next().value!)
        }
        check()
        return model
      }
      const name = tool.slice(PDF_TOOL_PREFIX.length)
      const success = (value: Record<string, unknown>): PdfToolResult => ({ ok: true, documentId: document.id, ...value })
      if (name === 'get_document') return success({ name: document.name, pageCount: document.pdf.numPages, currentPage: bindings.getCurrentPage(), annotationCount: bindings.getAnnotations().length, textExtraction: 'Selectable PDF text only; no OCR.' })
      if (name === 'read_pages') {
        const start = pageNumber(args.startPage, document), end = pageNumber(args.endPage ?? start, document)
        if (end < start || end - start + 1 > PDF_TOOL_LIMITS.readPages) invalid('每次只能读取按顺序排列的 1–5 页。')
        let remaining = (args.maxChars as number | undefined) ?? 12_000
        const pages = []
        let nextCursor: { startPage: number; endPage: number; offset: number } | null = null
        for (let number = start; number <= end; number++) {
          const model = await loadPage(number)
          const offset = number === start ? (args.offset as number | undefined) ?? 0 : 0
          if (offset > model.text.length) invalid('offset 超出当前页文字长度。')
          const text = model.text.slice(offset, offset + remaining)
          const endOffset = offset + text.length
          pages.push({ page: number, text, offset, endOffset, totalChars: model.text.length, truncated: endOffset < model.text.length })
          remaining -= text.length
          if (endOffset < model.text.length) { nextCursor = { startPage: number, endPage: end, offset: endOffset }; break }
          if (!remaining && number < end) { nextCursor = { startPage: number + 1, endPage: end, offset: 0 }; break }
        }
        return success({ pages, nextCursor })
      }
      if (name === 'search') {
        const start = pageNumber(args.startPage ?? 1, document)
        const limit = (args.limit as number | undefined) ?? 20
        const matches = []
        for (let number = start; number <= document.pdf.numPages; number++) {
          const model = await loadPage(number)
          const offset = number === start ? (args.offset as number | undefined) ?? 0 : 0
          if (offset > model.text.length) invalid('offset 超出当前页文字长度。')
          const pattern = literalPattern(args.query as string, args.caseSensitive as boolean | undefined)
          pattern.lastIndex = offset
          let match: RegExpExecArray | null
          while ((match = pattern.exec(model.text))) {
            const range = { start: match.index, end: match.index + match[0].length }
            matches.push({ page: number, offset: range.start, endOffset: range.end, text: match[0], excerpt: excerpt(model.text, range) })
            if (matches.length === limit) return success({ matches, nextCursor: { startPage: number, offset: range.end } })
          }
        }
        return success({ matches, nextCursor: null })
      }
      if (name === 'list_annotations') {
        if (args.page !== undefined) pageNumber(args.page, document)
        const all = bindings.getAnnotations().filter(item => (args.page === undefined || item.page === args.page) && (args.kind === undefined || item.kind === args.kind))
        const offset = (args.offset as number | undefined) ?? 0, limit = (args.limit as number | undefined) ?? 20
        if (offset > all.length) invalid('offset 超出标注数量。')
        const annotations = all.slice(offset, offset + limit).map(item => ({ id: item.id, page: item.page, kind: item.kind, color: item.color, text: item.text.slice(0, 500), comment: item.comment.slice(0, 1000), truncated: item.text.length > 500 || item.comment.length > 1000, createdAt: item.createdAt }))
        return success({ annotations, total: all.length, nextOffset: offset + annotations.length < all.length ? offset + annotations.length : null })
      }
      const number = pageNumber(args.page, document)
      if (name === 'navigate_page') { check(); bindings.onNavigate(number); return success({ page: number }) }
      if (name === 'add_note' && args.occurrence !== undefined && args.quote === undefined) invalid('occurrence 需要同时提供 quote。')
      const quote = (name === 'highlight_text' ? args.text : args.quote) as string | undefined
      const model = quote ? await loadPage(number) : null
      const nativePage = model?.page ?? await document.pdf.getPage(number)
      check()
      const match = model && quote ? quoteMatch(model, quote, args.occurrence as number | undefined) : null
      const rects = model && match ? await measureMatch(model, match, check) : []
      check()
      const kind = name === 'highlight_text' ? 'highlight' : 'note'
      const annotation: Annotation = {
        id: crypto.randomUUID(), page: number, kind, color: (args.color as string | undefined) ?? (kind === 'highlight' ? '#ffff00' : '#f5cd52'),
        rects, text: match && model ? model.text.slice(match.start, match.end) : '', comment: kind === 'note' ? (args.comment as string).trim() : '', createdAt: Date.now(),
      }
      if (kind === 'note') {
        const [left, bottom, right, top] = nativePage.view
        const width = Math.min(24, right - left), height = Math.min(24, top - bottom)
        const anchor = rects.at(-1)
        annotation.rects = [{ x: Math.max(left, Math.min(right - width, anchor ? anchor.x + anchor.width + 4 : right - width - 12)), y: Math.max(bottom, Math.min(top - height, anchor ? anchor.y + anchor.height - height : top - height - 12)), width, height }]
      }
      check()
      bindings.onAddAnnotation(annotation)
      return success({ annotationId: annotation.id, page: number, kind, text: annotation.text, rects: annotation.rects })
    } catch (error) {
      if (error instanceof PdfToolError) return { ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }
      return { ok: false, error: { code: 'PDF_TOOL_FAILED', message: error instanceof Error ? error.message.slice(0, 500) : 'PDF 工具执行失败。' } }
    }
  }
}
