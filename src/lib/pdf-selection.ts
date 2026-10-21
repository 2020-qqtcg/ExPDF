import type { PdfRect } from '../types'

/** Range rectangles often repeat a span's bounds, or split one line at font changes. */
export function mergeSelectionRects(rects: PdfRect[]): PdfRect[] {
  const merged: PdfRect[] = []
  for (const rect of rects) {
    let next = { ...rect }
    for (let index = merged.length - 1; index >= 0; index--) {
      const other = merged[index]
      const overlap = Math.min(next.y + next.height, other.y + other.height) - Math.max(next.y, other.y)
      const sameLine = overlap >= Math.min(next.height, other.height) * .7 && Math.abs(next.y + next.height / 2 - other.y - other.height / 2) <= Math.max(next.height, other.height) * .3
      const gap = Math.max(next.x, other.x) - Math.min(next.x + next.width, other.x + other.width)
      if (!sameLine || gap > Math.max(.8, Math.min(next.height, other.height) * .18)) continue
      const x = Math.min(next.x, other.x), y = Math.min(next.y, other.y)
      next = { x, y, width: Math.max(next.x + next.width, other.x + other.width) - x, height: Math.max(next.y + next.height, other.y + other.height) - y }
      merged.splice(index, 1)
    }
    merged.push(next)
  }
  return merged
}

export type PdfSelectionSignal = { type: 'start' | 'change' | 'finish' | 'clear' | 'dismiss' | 'cancel'; pointerActive?: boolean }
type Listener = (signal: PdfSelectionSignal) => void
const pages = new Map<HTMLElement, Listener>()
let active: HTMLElement | null = null
let pointer: HTMLElement | null = null
let selected: HTMLElement | null = null
let frame = 0

function owner(node: Node | null) {
  const element = node instanceof Element ? node : node?.parentElement
  const page = element?.closest<HTMLElement>('.pdf-page') ?? null
  return page && pages.has(page) ? page : null
}
function emit(page: HTMLElement | null, signal: PdfSelectionSignal) { if (page) pages.get(page)?.(signal) }
function stopFrame() { cancelAnimationFrame(frame); frame = 0 }
function down(event: PointerEvent) {
  const target = event.target as Element
  if (target.closest('.pdf-ask-codex, .pdf-selection-toolbar, .pdf-selection-note')) return
  emit(active, { type: 'dismiss' })
  active = owner(target)
  pointer = target.closest('.pdf-text-layer') ? active : null
  emit(pointer, { type: 'start', pointerActive: true })
}
function change() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const selection = window.getSelection()
    const next = selection && !selection.isCollapsed ? owner(selection.anchorNode) : null
    if (selected !== next) emit(selected, { type: 'clear' })
    selected = next
    if (next) {
      if (active !== next) emit(active, { type: 'dismiss' })
      active = next
      emit(next, { type: 'change', pointerActive: pointer === next })
    }
  })
}
function up() { const page = pointer; pointer = null; stopFrame(); emit(page, { type: 'finish' }) }
function cancel() { stopFrame(); emit(pointer ?? active, { type: 'cancel' }); pointer = null }
function key(event: KeyboardEvent) { if (event.key === 'Escape') cancel() }

/** A document has one native selection. Route its events only to the owning page. */
export function watchPdfSelection(page: HTMLElement, listener: Listener) {
  pages.set(page, listener)
  if (pages.size === 1) {
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('selectionchange', change)
    document.addEventListener('keydown', key)
  }
  return () => {
    pages.delete(page)
    if (active === page) active = null
    if (pointer === page) pointer = null
    if (selected === page) selected = null
    if (pages.size) return
    stopFrame()
    document.removeEventListener('pointerdown', down, true)
    document.removeEventListener('pointerup', up)
    document.removeEventListener('pointercancel', cancel)
    document.removeEventListener('selectionchange', change)
    document.removeEventListener('keydown', key)
  }
}

export function claimPdfSelection(page: HTMLElement) {
  if (active !== page) emit(active, { type: 'dismiss' })
  active = page
}
