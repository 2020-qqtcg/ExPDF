import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import { TextLayer } from 'pdfjs-dist'
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist'
import type { Annotation, PdfRect, Point, TextStyle, Tool } from '../types'
import { layoutTextAnnotation } from '../lib/text'
import { fontCssFamily } from '../lib/fonts'
import { claimPdfSelection, mergeSelectionRects, watchPdfSelection } from '../lib/pdf-selection'
import type { PdfSelectionSignal } from '../lib/pdf-selection'
import { squigglyPath, SQUIGGLY_STROKE_WIDTH, TEXT_MARKUP_STROKE_WIDTH } from '../lib/markup'
import SelectionToolbar, { SELECTION_MARKUP_COLORS } from './SelectionToolbar'
import type { SelectionMarkup } from './SelectionToolbar'
import SelectionNote from './SelectionNote'
import './pdf-page.css'

interface PdfPageProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  scale: number
  rotation: number
  tool: Tool
  color: string
  annotations: Annotation[]
  selectedId: string | null
  searchQuery: string
  searchMatchIndex?: number
  textStyle: TextStyle
  textDraft: Annotation | null
  onAdd: (annotation: Annotation) => void
  onUpdate: (annotation: Annotation) => void
  onSelect: (id: string | null) => void
  onTextDraftChange: (annotation: Annotation) => void
  onTextCommit: () => void
  onTextCancel: () => void
  onPageVisible?: (page: number) => void
  onAskCodex?: (quote: string, page: number) => void
  onNotify?: (message: string) => void
}

interface QuotePrompt {
  text: string
  rects: PdfRect[]
  obstacles: PdfRect[]
  source: 'selection' | 'annotation' | 'completed'
}

interface AnnotationDrag {
  annotation: Annotation
  pointerId: number
  target: SVGGElement
  clientX: number
  clientY: number
  origin: Point
  offset: Point
  moved: boolean
}

function scrollParent(element: HTMLElement): HTMLElement {
  let parent = element.parentElement
  while (parent) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflow + getComputedStyle(parent).overflowY)) return parent
    parent = parent.parentElement
  }
  return document.scrollingElement as HTMLElement
}

export function PdfPage({ pdf, pageNumber, scale, rotation, tool, color, annotations, selectedId, searchQuery, searchMatchIndex, textStyle, textDraft, onAdd, onUpdate, onSelect, onTextDraftChange, onTextCommit, onTextCancel, onPageVisible, onAskCodex, onNotify }: PdfPageProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const textRef = useRef<HTMLDivElement>(null)
  const renderRef = useRef<RenderTask | null>(null)
  const drawingRef = useRef<Point[] | null>(null)
  const panRef = useRef<{ parent: HTMLElement; x: number; y: number; left: number; top: number } | null>(null)
  const annotationDragRef = useRef<AnnotationDrag | null>(null)
  const dragFrameRef = useRef(0)
  const suppressClickRef = useRef(0)
  const editorMetricsRef = useRef<{ key: string; offset: number } | null>(null)
  const selectionHandlerRef = useRef<(signal: PdfSelectionSignal) => void>(() => {})
  const selectedQuoteIdRef = useRef<string | null>(null)
  const promptObstaclesRef = useRef<{ page: PDFPageProxy | null; version: number; rects: PdfRect[] } | null>(null)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [nearby, setNearby] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [textVersion, setTextVersion] = useState(0)
  const [draft, setDraft] = useState<Point[]>([])
  const [panning, setPanning] = useState(false)
  const [dragPreview, setDragPreview] = useState<Annotation | null>(null)
  const [quotePrompt, setQuotePrompt] = useState<QuotePrompt | null>(null)
  const [noteDraft, setNoteDraft] = useState<Annotation | null>(null)
  const [copying, setCopying] = useState(false)
  const [selectionPreview, setSelectionPreview] = useState<PdfRect[]>([])
  const [, updatePromptPosition] = useState(0)
  const visibleCallback = useRef(onPageVisible)
  visibleCallback.current = onPageVisible
  selectionHandlerRef.current = handleSelectionSignal

  useEffect(() => {
    let disposed = false
    setPage(null)
    setReady(false)
    setError('')
    pdf.getPage(pageNumber).then(value => { if (!disposed) setPage(value) }).catch(() => { if (!disposed) setError('这一页暂时无法加载') })
    return () => { disposed = true }
  }, [pdf, pageNumber])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const observer = new IntersectionObserver(entries => {
      // A restore and fit-width reflow can queue multiple states for this page.
      const latest = entries[entries.length - 1]
      if (latest) setNearby(latest.isIntersecting)
    }, { rootMargin: '1200px 600px' })
    observer.observe(root)
    const visibleObserver = new IntersectionObserver(entries => {
      const latest = entries[entries.length - 1]
      if (latest?.isIntersecting && latest.intersectionRatio >= 0.5) visibleCallback.current?.(pageNumber)
    }, { threshold: [0.5] })
    visibleObserver.observe(root)
    return () => { observer.disconnect(); visibleObserver.disconnect() }
  }, [pageNumber])

  const viewport = useMemo(() => page?.getViewport({ scale, rotation: (page.rotate + rotation) % 360 }), [page, scale, rotation])
  const width = viewport?.width ?? 595 * scale
  const height = viewport?.height ?? 842 * scale
  const effectiveScale = scale * (page?.userUnit ?? 1)
  const activeTextDraft = textDraft?.page === pageNumber && textDraft.kind === 'text' ? textDraft : null
  const promptVisible = !!quotePrompt && !dragPreview && !activeTextDraft
  const popupVisible = promptVisible || !!noteDraft

  useEffect(() => () => cancelAnnotationDrag(), [pdf, pageNumber, rotation, scale, tool])

  useEffect(() => { setQuotePrompt(null); setSelectionPreview([]); setNoteDraft(null) }, [pdf, pageNumber, tool])

  useEffect(() => {
    if (!popupVisible) return
    let frame = 0
    function update() {
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; updatePromptPosition(value => value + 1) })
    }
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    return () => { window.removeEventListener('scroll', update, true); window.removeEventListener('resize', update); cancelAnimationFrame(frame) }
  }, [popupVisible])

  useEffect(() => {
    if (!nearby || !rootRef.current) { setQuotePrompt(null); return }
    return watchPdfSelection(rootRef.current, signal => selectionHandlerRef.current(signal))
  }, [nearby])

  useEffect(() => {
    const nextId = tool === 'select' && onAskCodex ? selectedId : null
    if (nextId === selectedQuoteIdRef.current) return
    selectedQuoteIdRef.current = nextId
    if (nextId && !annotationDragRef.current) {
      const annotation = annotations.find(item => item.id === nextId && item.page === pageNumber)
      if (annotation && ['highlight', 'underline', 'strikeout', 'squiggly'].includes(annotation.kind) && annotation.text.trim()) {
        claimPdfSelection(rootRef.current!)
        setQuotePrompt(makeQuotePrompt(annotation.text, annotation.rects, 'annotation'))
        return
      }
    }
    setQuotePrompt(current => current?.source === 'annotation' ? null : current)
  }, [selectedId, annotations, onAskCodex, tool, pageNumber])

  useEffect(() => {
    function escapeDrag(event: KeyboardEvent) {
      if (event.key !== 'Escape' || !annotationDragRef.current) return
      event.preventDefault()
      event.stopPropagation()
      cancelAnnotationDrag()
    }
    const blur = () => cancelAnnotationDrag()
    window.addEventListener('keydown', escapeDrag, true)
    window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', escapeDrag, true); window.removeEventListener('blur', blur) }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let disposed = false
    const previous = renderRef.current
    previous?.cancel()
    const render = async () => {
      if (previous) await previous.promise.catch(() => {})
      if (disposed) return
      if (!page || !viewport || !nearby) {
        canvas.width = 0
        canvas.height = 0
        setReady(false)
        return
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const buffer = document.createElement('canvas')
      buffer.width = Math.ceil(viewport.width * dpr)
      buffer.height = Math.ceil(viewport.height * dpr)
      const context = buffer.getContext('2d', { alpha: false })
      if (!context) return
      const task = page.render({ canvas: buffer, canvasContext: context, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] })
      renderRef.current = task
      try {
        await task.promise
        if (!disposed) {
          // Keep the last complete bitmap while zooming; swap only after rendering.
          canvas.width = buffer.width
          canvas.height = buffer.height
          canvas.getContext('2d', { alpha: false })?.drawImage(buffer, 0, 0)
          setReady(true); setError('')
        }
      } catch (cause) {
        if (!disposed && !(cause instanceof Error && cause.name === 'RenderingCancelledException')) {
          setReady(false)
          setError('这一页渲染失败，请重新打开文件')
        }
      } finally {
        if (renderRef.current === task) renderRef.current = null
        buffer.width = 0
        buffer.height = 0
      }
    }
    void render()
    return () => { disposed = true; renderRef.current?.cancel() }
  }, [page, viewport, nearby])

  useEffect(() => {
    const container = textRef.current
    if (!container) return
    container.replaceChildren()
    if (!page || !viewport || !nearby) return
    let disposed = false
    const layer = new TextLayer({ textContentSource: page.streamTextContent(), container, viewport })
    // TextLayer lays text out in unrotated page space; its CSS rotates the entire layer.
    container.style.width = `${viewport.rotation % 180 ? viewport.height : viewport.width}px`
    container.style.height = `${viewport.rotation % 180 ? viewport.width : viewport.height}px`
    layer.render().then(() => { if (!disposed) setTextVersion(value => value + 1) }).catch(() => {})
    return () => { disposed = true; layer.cancel(); container.replaceChildren() }
  }, [page, viewport, nearby])

  useEffect(() => {
    const container = textRef.current
    if (!container) return
    container.querySelectorAll('mark.pdf-search-mark').forEach(mark => mark.replaceWith(document.createTextNode(mark.textContent ?? '')))
    container.normalize()
    const query = searchQuery.trim().toLocaleLowerCase()
    if (!query) return
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    let match = 0
    for (const node of nodes) {
      const value = node.data
      const lower = value.toLocaleLowerCase()
      let index = lower.indexOf(query)
      if (index < 0) continue
      let start = 0
      const fragment = document.createDocumentFragment()
      while (index >= 0) {
        fragment.append(value.slice(start, index))
        const mark = document.createElement('mark')
        mark.className = `pdf-search-mark${match === (searchMatchIndex ?? 0) ? ' current' : ''}`
        mark.textContent = value.slice(index, index + query.length)
        fragment.append(mark)
        match += 1
        start = index + query.length
        index = lower.indexOf(query, start)
      }
      fragment.append(value.slice(start))
      node.replaceWith(fragment)
    }
  }, [searchQuery, searchMatchIndex, textVersion])

  useEffect(() => {
    // A reader may select text first, then choose a markup tool in the toolbar.
    annotateSelection()
  }, [tool])

  function pointAt(clientX: number, clientY: number): Point {
    const bounds = canvasRef.current!.getBoundingClientRect()
    const point = viewport!.convertToPdfPoint(clientX - bounds.left, clientY - bounds.top)
    return { x: point[0], y: point[1] }
  }

  function add(kind: Annotation['kind'], rects: PdfRect[], text = '', points?: Point[], annotationColor = color) {
    onAdd({ id: crypto.randomUUID(), page: pageNumber, kind, color: annotationColor, rects, text, comment: '', points, createdAt: Date.now() })
  }

  function readSelection() {
    if (!viewport) return null
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null
    const layer = textRef.current!
    if (!layer.contains(selection.anchorNode) || !layer.contains(selection.focusNode)) return null
    const text = selection.toString()
    if (!text.trim()) return null
    const bounds = canvasRef.current!.getBoundingClientRect()
    const rects: PdfRect[] = []
    for (const rect of selection.getRangeAt(0).getClientRects()) {
      const left = Math.max(rect.left, bounds.left)
      const top = Math.max(rect.top, bounds.top)
      const right = Math.min(rect.right, bounds.right)
      const bottom = Math.min(rect.bottom, bounds.bottom)
      if (right - left < 1 || bottom - top < 1) continue
      const a = pointAt(left, top)
      const b = pointAt(right, bottom)
      const candidate = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
      rects.push(candidate)
    }
    return rects.length ? { selection, text, rects: mergeSelectionRects(rects) } : null
  }

  function handleSelectionSignal(signal: PdfSelectionSignal) {
    if (signal.type === 'start' || signal.type === 'dismiss' || signal.type === 'cancel' || signal.type === 'clear') {
      setQuotePrompt(current => signal.type === 'clear' && current?.source !== 'selection' ? current : null)
      setSelectionPreview(current => current.length ? [] : current)
      if (signal.type === 'cancel') {
        if (textRef.current?.contains(window.getSelection()?.anchorNode ?? null)) window.getSelection()?.removeAllRanges()
      }
      return
    }
    if (signal.type === 'finish') { finishSelection(); return }
    if (tool === 'select') {
      if (!signal.pointerActive) showSelectionPrompt()
    } else if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(tool)) {
      const selected = readSelection()
      setSelectionPreview(selected?.rects ?? [])
    }
  }

  function finishSelection() {
    annotateSelection()
    setSelectionPreview(current => current.length ? [] : current)
  }

  function showSelectionPrompt() {
    if (tool !== 'select' || activeTextDraft || noteDraft || annotationDragRef.current) return
    const selected = readSelection()
    if (selected) { claimPdfSelection(rootRef.current!); setQuotePrompt(makeQuotePrompt(selected.text, selected.rects, 'selection')) }
    else setQuotePrompt(current => current?.source === 'selection' ? null : current)
  }

  function showAnnotationPrompt(annotation: Annotation) {
    if (annotation.kind === 'note' && annotation.text.trim()) {
      setQuotePrompt(null)
      setNoteDraft(annotation)
      onSelect(null)
      return
    }
    if (onAskCodex && ['highlight', 'underline', 'strikeout', 'squiggly'].includes(annotation.kind) && annotation.text.trim()) {
      claimPdfSelection(rootRef.current!)
      setQuotePrompt(makeQuotePrompt(annotation.text, annotation.rects, 'annotation'))
    }
  }

  function makeQuotePrompt(text: string, rects: PdfRect[], source: QuotePrompt['source']): QuotePrompt {
    if (source === 'selection') return { text, rects, source, obstacles: [] }
    // Measure nearby text once per text layer, not on every scroll or selection update.
    if (promptObstaclesRef.current?.page !== page || promptObstaclesRef.current.version !== textVersion) {
      const obstacles: PdfRect[] = []
      textRef.current?.querySelectorAll('span:not(.markedContent)').forEach(span => {
        if (!span.textContent?.trim()) return
        const bounds = span.getBoundingClientRect()
        if (!bounds.width || !bounds.height) return
        const a = pointAt(bounds.left, bounds.top), b = pointAt(bounds.right, bounds.bottom)
        obstacles.push({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) })
      })
      promptObstaclesRef.current = { page, version: textVersion, rects: mergeSelectionRects(obstacles) }
    }
    return { text, rects, source, obstacles: promptObstaclesRef.current.rects }
  }

  function annotateSelection() {
    if (tool === 'select') { showSelectionPrompt(); return }
    if (!['highlight', 'underline', 'strikeout', 'squiggly'].includes(tool)) return
    const selected = readSelection()
    if (!selected) return
    setSelectionPreview(current => current.length ? [] : current)
    add(tool as SelectionMarkup, selected.rects, selected.text.trim())
    selected.selection.removeAllRanges()
    if (onAskCodex) setQuotePrompt(makeQuotePrompt(selected.text, selected.rects, 'completed'))
  }

  function screenRect(rect: PdfRect) {
    const a = viewport!.convertToViewportPoint(rect.x, rect.y)
    const b = viewport!.convertToViewportPoint(rect.x + rect.width, rect.y + rect.height)
    return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), width: Math.abs(b[0] - a[0]), height: Math.abs(b[1] - a[1]) }
  }

  function clearSelectionPrompt() {
    setQuotePrompt(null)
    setSelectionPreview([])
    window.getSelection()?.removeAllRanges()
  }

  function applySelectionMarkup(kind: SelectionMarkup) {
    if (!quotePrompt || quotePrompt.source !== 'selection') return
    const selected = quotePrompt
    clearSelectionPrompt()
    add(kind, selected.rects, selected.text.trim(), undefined, SELECTION_MARKUP_COLORS[kind])
  }

  function addSelectionNote() {
    if (!quotePrompt || !viewport || quotePrompt.source !== 'selection') return
    const selected = quotePrompt
    const end = screenRect(selected.rects[selected.rects.length - 1])
    const size = 24 * effectiveScale
    const left = Math.max(0, Math.min(width - size, end.x + end.width + 4))
    const top = Math.max(0, Math.min(height - size, end.y + end.height - size))
    const canvas = canvasRef.current!.getBoundingClientRect()
    const a = pointAt(canvas.left + left, canvas.top + top)
    const b = pointAt(canvas.left + left + size, canvas.top + top + size)
    clearSelectionPrompt()
    setNoteDraft({ id: crypto.randomUUID(), page: pageNumber, kind: 'note', color: '#fffc9e', rects: [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }], text: selected.text.trim(), comment: '', createdAt: Date.now() })
  }

  async function copySelection() {
    if (!quotePrompt || copying) return
    const selected = quotePrompt
    setCopying(true)
    try {
      await navigator.clipboard.writeText(selected.text)
      // UPDF keeps the blue native selection after copying, but dismisses its toolbar.
      setQuotePrompt(current => current === selected ? null : current)
      onNotify?.('已复制选中文字')
    } catch { onNotify?.('复制失败，请重试或手动复制选中文字。') }
    finally { setCopying(false) }
  }

  function squigglyFor(rect: PdfRect) {
    const path = squigglyPath(rect)
    const position = (point: Point) => viewport!.convertToViewportPoint(point.x, point.y).map(value => value.toFixed(2)).join(',')
    return `M${position(path.start)} ${path.curves.map(curve => `C${position(curve.control1)} ${position(curve.control2)} ${position(curve.end)}`).join(' ')}`
  }

  function pathFor(points: Point[]) {
    return points.map((point, index) => {
      const [x, y] = viewport!.convertToViewportPoint(point.x, point.y)
      return `${index ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`
    }).join(' ') + (points.length === 1 ? ' l0.01,0.01' : '')
  }

  function textMatrix(annotation: Annotation) {
    const style = annotation.textStyle ?? textStyle
    const origin = annotation.points?.[0] ?? { x: annotation.rects[0]?.x ?? 0, y: (annotation.rects[0]?.y ?? 0) + (annotation.rects[0]?.height ?? 0) }
    const angle = style.rotation * Math.PI / 180
    const [x, y] = viewport!.convertToViewportPoint(origin.x, origin.y)
    const horizontal = viewport!.convertToViewportPoint(origin.x + Math.cos(angle), origin.y + Math.sin(angle))
    const vertical = viewport!.convertToViewportPoint(origin.x + Math.sin(angle), origin.y - Math.cos(angle))
    return [horizontal[0] - x, horizontal[1] - y, vertical[0] - x, vertical[1] - y, x, y]
  }

  function textHeight(annotation: Annotation) {
    const style = annotation.textStyle ?? textStyle
    return Math.max(1, (annotation.textLines ?? annotation.text.split('\n')).length) * style.fontSize * style.lineHeight
  }

  function textEditorMatrix(annotation: Annotation) {
    const style = annotation.textStyle ?? textStyle
    const family = fontCssFamily(style.fontId)
    const fontReady = Array.from(document.fonts).some(face => face.family === family && face.status === 'loaded')
    const key = `${family}|${style.fontSize}|${style.bold}|${style.italic}|${style.lineHeight}|${fontReady}`
    if (editorMetricsRef.current?.key !== key) {
      // Match the textarea's first-line baseline to the saved SVG/PDF baseline.
      const line = document.createElement('div')
      line.style.cssText = 'position:fixed;left:-10000px;top:0;visibility:hidden;display:inline-block;white-space:pre;padding:0;margin:0;border:0;'
      line.style.fontFamily = family
      line.style.fontSize = `${style.fontSize}px`
      line.style.fontWeight = style.bold ? '700' : '400'
      line.style.fontStyle = style.italic ? 'italic' : 'normal'
      line.style.lineHeight = String(style.lineHeight)
      line.textContent = 'M'
      const marker = document.createElement('span')
      marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;'
      line.append(marker)
      document.body.append(line)
      const baseline = marker.getBoundingClientRect().top - line.getBoundingClientRect().top
      line.remove()
      editorMetricsRef.current = { key, offset: style.fontSize * 0.85 - baseline }
    }
    const matrix = textMatrix(annotation)
    const offset = editorMetricsRef.current.offset
    matrix[4] += matrix[2] * offset
    matrix[5] += matrix[3] * offset
    return matrix
  }

  function shiftedAnnotation(drag: AnnotationDrag): Annotation {
    const { x, y } = drag.offset
    return {
      ...drag.annotation,
      rects: drag.annotation.rects.map(rect => ({ ...rect, x: rect.x + x, y: rect.y + y })),
      points: drag.annotation.points?.map(point => ({ x: point.x + x, y: point.y + y })),
    }
  }

  function releaseAnnotationPointer(drag: AnnotationDrag) {
    if (drag.target.hasPointerCapture(drag.pointerId)) drag.target.releasePointerCapture(drag.pointerId)
  }

  function cancelAnnotationDrag() {
    const drag = annotationDragRef.current
    if (!drag) return
    annotationDragRef.current = null
    cancelAnimationFrame(dragFrameRef.current); dragFrameRef.current = 0
    suppressClickRef.current = Date.now() + 1000
    setDragPreview(null)
    releaseAnnotationPointer(drag)
  }

  function beginAnnotationDrag(event: ReactPointerEvent<SVGGElement>, annotation: Annotation) {
    if (tool !== 'select' || !viewport || event.button !== 0 || !event.isPrimary) return
    event.stopPropagation()
    event.preventDefault()
    setQuotePrompt(null)
    suppressClickRef.current = 0
    window.getSelection()?.removeAllRanges()
    annotationDragRef.current = {
      annotation, pointerId: event.pointerId, target: event.currentTarget,
      clientX: event.clientX, clientY: event.clientY,
      origin: pointAt(event.clientX, event.clientY), offset: { x: 0, y: 0 }, moved: false,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function moveAnnotationDrag(event: ReactPointerEvent<SVGGElement>) {
    const drag = annotationDragRef.current
    if (!drag || drag.pointerId !== event.pointerId || !viewport) return
    event.stopPropagation()
    event.preventDefault()
    if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < (event.pointerType === 'touch' ? 6 : 3)) return
    drag.moved = true
    const current = pointAt(event.clientX, event.clientY)
    const corners = [[0, 0], [width, 0], [0, height], [width, height]].map(([x, y]) => viewport.convertToPdfPoint(x, y))
    const xs = drag.annotation.rects.flatMap(rect => [rect.x, rect.x + rect.width]).concat(drag.annotation.points?.map(point => point.x) ?? [])
    const ys = drag.annotation.rects.flatMap(rect => [rect.y, rect.y + rect.height]).concat(drag.annotation.points?.map(point => point.y) ?? [])
    const clamp = (value: number, min: number, max: number) => min <= max ? Math.max(min, Math.min(max, value)) : (min + max) / 2
    drag.offset = {
      x: clamp(current.x - drag.origin.x, Math.min(...corners.map(point => point[0])) - Math.min(...xs), Math.max(...corners.map(point => point[0])) - Math.max(...xs)),
      y: clamp(current.y - drag.origin.y, Math.min(...corners.map(point => point[1])) - Math.min(...ys), Math.max(...corners.map(point => point[1])) - Math.max(...ys)),
    }
    if (!dragFrameRef.current) dragFrameRef.current = requestAnimationFrame(() => {
      dragFrameRef.current = 0
      if (annotationDragRef.current === drag) setDragPreview(shiftedAnnotation(drag))
    })
  }

  function finishAnnotationDrag(event: ReactPointerEvent<SVGGElement>) {
    const drag = annotationDragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    moveAnnotationDrag(event)
    event.stopPropagation()
    event.preventDefault()
    annotationDragRef.current = null
    cancelAnimationFrame(dragFrameRef.current); dragFrameRef.current = 0
    setDragPreview(null)
    releaseAnnotationPointer(drag)
    if (drag.moved) {
      suppressClickRef.current = Date.now() + 1000
      if (Math.abs(drag.offset.x) > 0.001 || Math.abs(drag.offset.y) > 0.001) onUpdate(shiftedAnnotation(drag))
    }
  }

  function beginPointer(event: ReactPointerEvent<HTMLDivElement>) {
    suppressClickRef.current = 0
    if (!viewport || event.button !== 0) return
    if (tool === 'hand') {
      const parent = scrollParent(rootRef.current!)
      panRef.current = { parent, x: event.clientX, y: event.clientY, left: parent.scrollLeft, top: parent.scrollTop }
      event.currentTarget.setPointerCapture(event.pointerId)
      setPanning(true)
      event.preventDefault()
    } else if (tool === 'draw') {
      drawingRef.current = [pointAt(event.clientX, event.clientY)]
      setDraft(drawingRef.current)
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
  }

  function movePointer(event: ReactPointerEvent<HTMLDivElement>) {
    if (panRef.current) {
      const pan = panRef.current
      pan.parent.scrollLeft = pan.left - (event.clientX - pan.x)
      pan.parent.scrollTop = pan.top - (event.clientY - pan.y)
    }
    if (drawingRef.current) {
      const next = pointAt(event.clientX, event.clientY)
      const last = drawingRef.current[drawingRef.current.length - 1]
      if (Math.hypot(next.x - last.x, next.y - last.y) > 0.6 / effectiveScale) {
        drawingRef.current.push(next)
        setDraft([...drawingRef.current])
      }
    }
  }

  function endPointer(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    if (drawingRef.current && !cancelled) {
      const points = drawingRef.current
      const xs = points.map(point => point.x)
      const ys = points.map(point => point.y)
      const x = Math.min(...xs) - 2
      const y = Math.min(...ys) - 2
      add('draw', [{ x, y, width: Math.max(...xs) - x + 2, height: Math.max(...ys) - y + 2 }], '', points)
    }
    drawingRef.current = null
    setDraft([])
    panRef.current = null
    setPanning(false)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const pageStyle = { width, height, '--total-scale-factor': effectiveScale, '--scale-round-x': '1px', '--scale-round-y': '1px' } as CSSProperties
  const popupHost = rootRef.current?.closest<HTMLElement>('.reader-area') ?? null
  const toolbarPosition = viewport && popupHost && quotePrompt?.source === 'selection' && quotePrompt.rects.length ? (() => {
    const rects = quotePrompt.rects.map(screenRect)
    const canvas = canvasRef.current!.getBoundingClientRect()
    const host = popupHost.getBoundingClientRect()
    const leftEdge = Math.max(0, host.left) + 6
    const rightEdge = Math.min(window.innerWidth, host.right) - 6
    const topEdge = Math.max(0, host.top) + 6
    const bottomEdge = Math.min(window.innerHeight, host.bottom) - 6
    const top = canvas.top + Math.min(...rects.map(rect => rect.y))
    const bottom = canvas.top + Math.max(...rects.map(rect => rect.y + rect.height))
    if (bottom < topEdge || top > bottomEdge) return null
    const toolbarWidth = Math.min(488, rightEdge - leftEdge)
    const y = top - 48 >= topEdge ? top - 48 : bottom + 8 + 40 <= bottomEdge ? bottom + 8 : null
    if (y === null || toolbarWidth <= 0) return null
    const x = Math.max(leftEdge, Math.min(rightEdge - toolbarWidth, canvas.left + rects[0].x - 32))
    return { left: x - host.left, top: y - host.top, width: toolbarWidth }
  })() : null
  const notePosition = viewport && popupHost && noteDraft ? (() => {
    const canvas = canvasRef.current!.getBoundingClientRect()
    const host = popupHost.getBoundingClientRect()
    const anchor = screenRect(noteDraft.rects[0])
    const noteWidth = Math.min(376, host.width - 16)
    const noteHeight = Math.min(400, host.height - 16)
    return {
      width: noteWidth, height: noteHeight,
      left: Math.max(8, Math.min(host.width - noteWidth - 8, canvas.left + anchor.x - host.left)),
      top: Math.max(8, Math.min(host.height - noteHeight - 8, canvas.top + anchor.y + anchor.height + 8 - host.top)),
    }
  })() : null
  const askPosition = viewport && quotePrompt?.source !== 'selection' && quotePrompt?.rects.length ? (() => {
    const rects = quotePrompt.rects.map(screenRect)
    const left = Math.min(...rects.map(rect => rect.x))
    const right = Math.max(...rects.map(rect => rect.x + rect.width))
    const top = Math.min(...rects.map(rect => rect.y))
    const bottom = Math.max(...rects.map(rect => rect.y + rect.height))
    const canvas = canvasRef.current!.getBoundingClientRect()
    const scroller = scrollParent(rootRef.current!).getBoundingClientRect()
    const visibleLeft = Math.max(0, Math.max(0, scroller.left) - canvas.left)
    const visibleRight = Math.min(width, Math.min(window.innerWidth, scroller.right) - canvas.left)
    const visibleTop = Math.max(0, Math.max(0, scroller.top) - canvas.top)
    const visibleBottom = Math.min(height, Math.min(window.innerHeight, scroller.bottom) - canvas.top)
    if (right < visibleLeft || left > visibleRight || bottom < visibleTop || top > visibleBottom) return null
    const end = rects[rects.length - 1]
    const leftAtEnd = Math.max(visibleLeft + 6, Math.min(visibleRight - 112, end.x + end.width - 106))
    const obstacles = quotePrompt.obstacles.map(screenRect)
    const candidates = [
      { left: leftAtEnd, top: bottom + 8 },
      { left: end.x + end.width + 8, top: end.y + end.height / 2 - 15 },
      { left: leftAtEnd, top: top - 38 },
      { left: right + 8, top: Math.max(visibleTop + 6, Math.min(visibleBottom - 36, end.y)) },
      { left: left - 114, top: Math.max(visibleTop + 6, Math.min(visibleBottom - 36, end.y)) },
    ]
    return candidates.find(candidate => candidate.left >= visibleLeft + 6 && candidate.left + 106 <= visibleRight - 6 && candidate.top >= visibleTop + 6 && candidate.top + 30 <= visibleBottom - 6 && !obstacles.some(rect => candidate.left < rect.x + rect.width + 3 && candidate.left + 106 > rect.x - 3 && candidate.top < rect.y + rect.height + 3 && candidate.top + 30 > rect.y - 3)) ?? null
  })() : null

  return <div
    ref={rootRef}
    id={`page-${pageNumber}`}
    data-page-number={pageNumber}
    className={`pdf-page tool-${tool}${panning ? ' is-panning' : ''}${dragPreview ? ' is-annotation-dragging' : ''}`}
    style={pageStyle}
    aria-label={`第 ${pageNumber} 页`}
    onPointerDown={beginPointer}
    onPointerMove={movePointer}
    onPointerUp={event => endPointer(event)}
    onPointerCancel={event => endPointer(event, true)}
    onMouseUp={finishSelection}
    onClickCapture={event => {
      if (event.detail > 0 && Date.now() < suppressClickRef.current) {
        event.preventDefault()
        event.stopPropagation()
        suppressClickRef.current = 0
      }
    }}
    onClick={event => {
      if (!viewport) return
      if (tool === 'text') {
        if (event.detail > 1) return
        if (textDraft) { onTextCommit(); return }
        const anchor = pointAt(event.clientX, event.clientY)
        onAdd(layoutTextAnnotation({
          id: crypto.randomUUID(), page: pageNumber, kind: 'text', color: '#333333',
          points: [anchor], rects: [], text: '', comment: '', createdAt: Date.now(),
          textStyle: { ...textStyle, rotation: viewport.rotation },
        }))
      } else if (tool === 'note') {
        const a = pointAt(event.clientX, event.clientY)
        const b = pointAt(event.clientX + 24 * effectiveScale, event.clientY + 24 * effectiveScale)
        add('note', [{ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }])
      } else if (tool === 'select') {
        if (readSelection()) { onSelect(null); return }
        const mark = [...annotations].reverse().find(annotation => annotation.page === pageNumber && ['highlight', 'underline', 'strikeout', 'squiggly'].includes(annotation.kind) && annotation.rects.some(rect => {
          const bounds = screenRect(rect)
          const point = canvasRef.current!.getBoundingClientRect()
          const x = event.clientX - point.left, y = event.clientY - point.top
          return x >= bounds.x - 2 && x <= bounds.x + bounds.width + 2 && y >= bounds.y - 2 && y <= bounds.y + bounds.height + 2
        }))
        onSelect(mark?.id ?? null)
        if (mark) showAnnotationPrompt(mark)
      }
    }}
  >
    <canvas ref={canvasRef} className="pdf-page-canvas" style={{ width, height }} aria-hidden="true" />
    {!ready && <div className={`pdf-page-placeholder${error ? ' has-error' : ''}`}>{error || `第 ${pageNumber} 页`}</div>}
    <div ref={textRef} className="textLayer pdf-text-layer" />
    {viewport && <svg className={`pdf-annotation-layer${tool === 'select' ? ' can-select' : ''}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label="页面批注">
      {!!selectionPreview.length && ['highlight', 'underline', 'strikeout', 'squiggly'].includes(tool) && <g className="pdf-selection-preview" aria-hidden="true">
        {selectionPreview.map((rect, index) => {
          if (tool === 'highlight') return <rect key={index} {...screenRect(rect)} fill={color} fillOpacity={.38} />
          if (tool === 'squiggly') return <path key={index} d={squigglyFor(rect)} fill="none" stroke={color} strokeWidth={SQUIGGLY_STROKE_WIDTH * effectiveScale} strokeLinecap="round" />
          const lineY = tool === 'underline' ? rect.y + .5 : rect.y + rect.height / 2
          const [x1, y1] = viewport.convertToViewportPoint(rect.x, lineY)
          const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, lineY)
          return <line key={index} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={TEXT_MARKUP_STROKE_WIDTH * effectiveScale} />
        })}
      </g>}
      {annotations.filter(annotation => annotation.page === pageNumber && annotation.id !== activeTextDraft?.id).map(original => {
        const annotation = dragPreview?.id === original.id ? dragPreview : original
        return <g
        key={annotation.id}
        className={`pdf-mark pdf-mark-${annotation.kind}${selectedId === annotation.id ? ' is-selected' : ''}${dragPreview?.id === annotation.id ? ' is-dragging' : ''}`}
        onPointerDown={event => beginAnnotationDrag(event, annotation)}
        onPointerMove={moveAnnotationDrag}
        onPointerUp={finishAnnotationDrag}
        onPointerCancel={event => { if (annotationDragRef.current?.pointerId === event.pointerId) { event.stopPropagation(); cancelAnnotationDrag() } }}
        onLostPointerCapture={event => { if (annotationDragRef.current?.pointerId === event.pointerId) cancelAnnotationDrag() }}
        onClick={event => {
          if (tool === 'text' && annotation.kind === 'text') { event.stopPropagation(); onAdd(annotation) }
          else if (tool === 'select') { event.stopPropagation(); onSelect(annotation.id); showAnnotationPrompt(annotation) }
        }}
        onDoubleClick={event => {
          if (annotation.kind === 'text' && (tool === 'select' || tool === 'text')) {
            event.stopPropagation()
            event.preventDefault()
            if (!textDraft) onAdd(annotation)
          }
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            event.stopPropagation()
            if (event.key === 'Enter' && annotation.kind === 'text' && !textDraft) onAdd(annotation)
            else onSelect(annotation.id)
          }
        }}
        role="button"
        tabIndex={tool === 'select' ? 0 : -1}
        aria-label={annotation.comment || annotation.text || (annotation.kind === 'note' ? '便签' : '批注')}
      >
        <title>{annotation.kind === 'text' ? '拖动移动，双击编辑文字' : annotation.comment || annotation.text || '点击编辑批注'}</title>
        {annotation.kind === 'text' ? (() => {
          const style = annotation.textStyle ?? textStyle
          const lines = annotation.textLines ?? annotation.text.split('\n')
          const anchor = style.align === 'center' ? 'middle' : style.align === 'right' ? 'end' : 'start'
          const x = style.align === 'center' ? style.width / 2 : style.align === 'right' ? style.width : 0
          return <g transform={`matrix(${textMatrix(annotation).join(' ')})`}>
            <rect className="pdf-mark-hit" x={0} y={0} width={style.width} height={textHeight(annotation)} fill="transparent" />
            <text fill={annotation.color} fontFamily={fontCssFamily(style.fontId)} fontSize={style.fontSize} fontWeight={style.bold ? 700 : 400} fontStyle={style.italic ? 'italic' : 'normal'} textDecoration={style.underline ? 'underline' : undefined} textAnchor={anchor} xmlSpace="preserve">
              {lines.map((line, index) => <tspan key={index} x={x} y={style.fontSize * 0.85 + index * style.fontSize * style.lineHeight}>{line || '\u00a0'}</tspan>)}
            </text>
          </g>
        })() : annotation.kind === 'draw' && annotation.points?.length ? <>
          <path d={pathFor(annotation.points)} fill="none" stroke={annotation.color} strokeWidth={2 * effectiveScale} strokeLinecap="round" strokeLinejoin="round" />
          <path className="pdf-mark-hit" d={pathFor(annotation.points)} fill="none" stroke="transparent" strokeWidth={Math.max(12, 8 * effectiveScale)} />
        </> : annotation.rects.map((rect, index) => {
          const display = screenRect(rect)
          if (annotation.kind === 'note') return <g key={index}>
            <rect {...display} rx={3 * effectiveScale} fill={annotation.color} stroke="rgba(100,75,20,.22)" strokeWidth={effectiveScale} />
            <path d={`M${display.x + display.width * 0.25},${display.y + display.height * 0.37} h${display.width * 0.5} M${display.x + display.width * 0.25},${display.y + display.height * 0.57} h${display.width * 0.36}`} fill="none" stroke="#6c582a" strokeWidth={1.5 * effectiveScale} strokeLinecap="round" />
          </g>
          if (annotation.kind === 'highlight') return <rect key={index} {...display} fill={annotation.color} fillOpacity={0.38} />
          if (annotation.kind === 'squiggly') return <g key={index}><rect className="pdf-mark-hit" {...display} fill="transparent" /><path d={squigglyFor(rect)} fill="none" stroke={annotation.color} strokeWidth={SQUIGGLY_STROKE_WIDTH * effectiveScale} strokeLinecap="round" /></g>
          const lineY = annotation.kind === 'underline' ? rect.y + 0.5 : rect.y + rect.height / 2
          const [x1, y1] = viewport.convertToViewportPoint(rect.x, lineY)
          const [x2, y2] = viewport.convertToViewportPoint(rect.x + rect.width, lineY)
          return <g key={index}>
            <rect className="pdf-mark-hit" {...display} fill="transparent" />
            <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={annotation.color} strokeWidth={TEXT_MARKUP_STROKE_WIDTH * effectiveScale} />
          </g>
        })}
        {((tool === 'select' && selectedId === annotation.id) || dragPreview?.id === annotation.id) && annotation.rects.map((rect, index) => <rect key={`selected-${index}`} {...screenRect(rect)} fill="none" stroke="#8580f5" strokeWidth={1} strokeDasharray="3 2" rx={1} className="pdf-mark-outline" />)}
      </g>})}
      {!!draft.length && <path d={pathFor(draft)} fill="none" stroke={color} strokeWidth={2 * effectiveScale} strokeLinecap="round" strokeLinejoin="round" />}
    </svg>}
    {viewport && activeTextDraft && <textarea
      key={activeTextDraft.id}
      className="pdf-inline-text-editor"
      aria-label="页面文字"
      autoFocus
      spellCheck={false}
      value={activeTextDraft.text}
      style={{
        transform: `matrix(${textEditorMatrix(activeTextDraft).join(',')})`,
        width: (activeTextDraft.textStyle ?? textStyle).width,
        height: textHeight(activeTextDraft),
        fontFamily: fontCssFamily((activeTextDraft.textStyle ?? textStyle).fontId),
        fontSize: (activeTextDraft.textStyle ?? textStyle).fontSize,
        fontWeight: (activeTextDraft.textStyle ?? textStyle).bold ? 700 : 400,
        fontStyle: (activeTextDraft.textStyle ?? textStyle).italic ? 'italic' : 'normal',
        textDecoration: (activeTextDraft.textStyle ?? textStyle).underline ? 'underline' : undefined,
        textAlign: (activeTextDraft.textStyle ?? textStyle).align,
        lineHeight: (activeTextDraft.textStyle ?? textStyle).lineHeight,
        color: activeTextDraft.color,
      }}
      onChange={event => onTextDraftChange(layoutTextAnnotation({ ...activeTextDraft, text: event.target.value }))}
      onPointerDown={event => event.stopPropagation()}
      onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()}
      onMouseUp={event => event.stopPropagation()}
      onClick={event => event.stopPropagation()}
      onDoubleClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onTextCancel() }
        else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); event.stopPropagation(); onTextCommit() }
      }}
    />}
    {popupHost && quotePrompt?.source === 'selection' && toolbarPosition && !dragPreview && !activeTextDraft && !noteDraft && createPortal(<SelectionToolbar
      style={toolbarPosition} compact={toolbarPosition.width < 488} copying={copying} canAsk={!!onAskCodex}
      onAsk={() => { const text = quotePrompt.text; clearSelectionPrompt(); onAskCodex?.(text, pageNumber) }}
      onMarkup={applySelectionMarkup} onNote={addSelectionNote} onCopy={() => void copySelection()}
    />, popupHost)}
    {popupHost && noteDraft && notePosition && createPortal(<SelectionNote key={noteDraft.id} annotation={noteDraft} style={notePosition}
      onCancel={() => { setNoteDraft(null); onSelect(null) }}
      onCommit={comment => {
        const annotation = { ...noteDraft, comment }
        setNoteDraft(null)
        if (annotations.some(item => item.id === annotation.id)) onUpdate(annotation)
        else onAdd(annotation)
      }}
    />, popupHost)}
    {onAskCodex && quotePrompt && askPosition && !dragPreview && !activeTextDraft && <button
      type="button"
      className="pdf-ask-codex"
      style={askPosition}
      aria-label="问 Codex"
      onPointerDown={event => { event.preventDefault(); event.stopPropagation() }}
      onPointerUp={event => event.stopPropagation()}
      onMouseUp={event => event.stopPropagation()}
      onClick={event => {
        event.preventDefault()
        event.stopPropagation()
        const quote = quotePrompt.text
        setQuotePrompt(null)
        window.getSelection()?.removeAllRanges()
        if (selectedId) onSelect(null)
        onAskCodex(quote, pageNumber)
      }}
    ><svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 1.5 9.65 6.35 14.5 8 9.65 9.65 8 14.5 6.35 9.65 1.5 8 6.35 6.35Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg>问 Codex</button>}
  </div>
}

export default PdfPage
