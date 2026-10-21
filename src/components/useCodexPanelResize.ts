import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

const WIDTH_KEY = 'folio:codex-panel-width'
const clamp = (width: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(width)))
function readWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch { return null }
}
function saveWidth(width: number | null) {
  try {
    if (width === null) localStorage.removeItem(WIDTH_KEY)
    else localStorage.setItem(WIDTH_KEY, String(width))
  } catch { /* Resizing still works without storage. */ }
}
function defaultWidth() { return window.innerWidth <= 900 ? 360 : window.innerWidth <= 1000 ? 330 : window.innerWidth >= 1600 ? 420 : 390 }

export default function useCodexPanelResize(onResize: () => void) {
  const panel = useRef<HTMLElement>(null)
  const drag = useRef<{ id: number; x: number; width: number; preferred: number | null; target: HTMLDivElement } | null>(null)
  const [preferred, setPreferred] = useState(readWidth)
  const [bounds, setBounds] = useState({ min: 280, max: Math.max(280, window.innerWidth - 420), default: defaultWidth() })
  const [resizing, setResizing] = useState(false)
  const width = clamp(preferred ?? bounds.default, bounds.min, bounds.max)
  const latest = useRef({ preferred, bounds, width, onResize })
  latest.current = { preferred, bounds, width, onResize }

  function applyPreferred(next: number | null) {
    const current = latest.current
    if (clamp(next ?? current.bounds.default, current.bounds.min, current.bounds.max) !== current.width) current.onResize()
    setPreferred(next)
  }

  useLayoutEffect(() => {
    const layout = panel.current?.closest('.reader-layout')
    const reader = layout?.querySelector('.reader-area')
    if (!layout || !reader) return
    const measure = () => {
      const outer = layout.getBoundingClientRect()
      const max = Math.max(0, Math.floor(window.innerWidth <= 900 ? outer.width - 56 : outer.right - reader.getBoundingClientRect().left - 4 - 360))
      const next = { min: Math.min(280, max), max, default: defaultWidth() }
      const current = latest.current
      if (current.bounds.min === next.min && current.bounds.max === next.max && current.bounds.default === next.default) return
      if (clamp(current.preferred ?? next.default, next.min, next.max) !== current.width) current.onResize()
      setBounds(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(layout)
    observer.observe(reader)
    return () => observer.disconnect()
  }, [])

  function finish(cancelled: boolean, clientX?: number) {
    const active = drag.current
    if (!active) return
    drag.current = null
    if (cancelled) applyPreferred(active.preferred)
    else {
      const limits = latest.current.bounds
      const next = clamp(active.width + active.x - (clientX ?? active.x), limits.min, limits.max)
      applyPreferred(next); saveWidth(next)
    }
    setResizing(false)
    if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id)
  }
  useEffect(() => {
    if (!resizing) return
    document.body.classList.add('is-resizing-codex')
    const cancel = () => finish(true)
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); cancel()
    }
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', escape, true)
    return () => {
      document.body.classList.remove('is-resizing-codex')
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', escape, true)
    }
  }, [resizing])

  function begin(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !event.isPrimary || drag.current) return
    event.preventDefault(); event.stopPropagation()
    event.currentTarget.focus({ preventScroll: true })
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { id: event.pointerId, x: event.clientX, width, preferred, target: event.currentTarget }
    setResizing(true)
  }
  function move(event: PointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return
    event.preventDefault(); event.stopPropagation()
    applyPreferred(clamp(drag.current.width + drag.current.x - event.clientX, bounds.min, bounds.max))
  }
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.metaKey || event.ctrlKey || event.altKey || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault(); event.stopPropagation()
    if (drag.current) return
    const next = event.key === 'Home' ? bounds.min : event.key === 'End' ? bounds.max : width + (event.key === 'ArrowLeft' ? 1 : -1) * (event.shiftKey ? 40 : 10)
    const value = clamp(next, bounds.min, bounds.max)
    applyPreferred(value); saveWidth(value)
  }

  return {
    panel, width, resizing,
    separatorProps: {
      tabIndex: 0, role: 'separator', 'aria-label': '调整 Codex 侧栏宽度', 'aria-orientation': 'vertical' as const,
      'aria-valuemin': bounds.min, 'aria-valuemax': bounds.max, 'aria-valuenow': width, 'aria-valuetext': `${width} 像素`,
      onPointerDown: begin, onPointerMove: move,
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) { event.stopPropagation(); finish(false, event.clientX) } },
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) finish(true) },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => { if (drag.current?.id === event.pointerId) finish(true) },
      onKeyDown: keyDown,
      onDoubleClick: () => { applyPreferred(null); saveWidth(null) },
    },
  }
}
