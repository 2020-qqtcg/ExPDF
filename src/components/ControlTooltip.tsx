import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import './control-tooltip.css'

interface TooltipContent {
  target: HTMLElement
  label: string
  shortcut?: string
}

export default function ControlTooltip() {
  const id = useId()
  const tooltipRef = useRef<HTMLDivElement>(null)
  const [content, setContent] = useState<TooltipContent | null>(null)
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null)

  useEffect(() => {
    const root = tooltipRef.current?.closest('.app-shell')
    if (!root) return
    let active: HTMLElement | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    const enabled = (target: HTMLElement) => !target.matches(':disabled, [aria-disabled="true"]') && !!target.dataset.tooltip?.trim()
    const findTarget = (target: EventTarget | null) => target instanceof Element ? target.closest<HTMLElement>('[data-tooltip]') : null
    const observer = new MutationObserver(() => { if (active && !enabled(active)) hide() })
    function hide() {
      clearTimeout(timer)
      observer.disconnect()
      active = null
      setContent(null)
      setPosition(null)
    }
    function show(target: HTMLElement, delay: number) {
      if (!enabled(target)) return
      if (active === target) {
        if (!delay) {
          clearTimeout(timer)
          setContent({ target, label: target.dataset.tooltip!.trim(), shortcut: target.dataset.shortcut })
        }
        return
      }
      hide()
      active = target
      observer.observe(target, { attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'data-tooltip'] })
      const reveal = () => {
        if (active !== target || !target.isConnected || !enabled(target)) return
        setContent({ target, label: target.dataset.tooltip!.trim(), shortcut: target.dataset.shortcut })
      }
      if (delay) timer = setTimeout(reveal, delay)
      else reveal()
    }
    function pointerOver(event: Event) {
      if ((event as PointerEvent).pointerType === 'touch') return
      const target = findTarget(event.target)
      if (target && root!.contains(target)) show(target, 400)
    }
    function pointerOut(event: Event) {
      const related = (event as PointerEvent).relatedTarget
      if (active && !(related instanceof Node && active.contains(related)) && findTarget(event.target) === active) hide()
    }
    function focusIn(event: Event) {
      const target = findTarget(event.target)
      if (target?.matches(':focus-visible')) show(target, 0)
    }
    function focusOut(event: Event) {
      if (findTarget(event.target) === active) hide()
    }
    function keyDown(event: KeyboardEvent) { if (event.key === 'Escape') hide() }
    root.addEventListener('pointerover', pointerOver)
    root.addEventListener('pointerout', pointerOut)
    root.addEventListener('focusin', focusIn)
    root.addEventListener('focusout', focusOut)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', hide, true)
    document.addEventListener('keydown', keyDown, true)
    window.addEventListener('resize', hide)
    return () => {
      clearTimeout(timer)
      observer.disconnect()
      root.removeEventListener('pointerover', pointerOver)
      root.removeEventListener('pointerout', pointerOut)
      root.removeEventListener('focusin', focusIn)
      root.removeEventListener('focusout', focusOut)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', hide, true)
      document.removeEventListener('keydown', keyDown, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    if (!content || !tooltip) return
    const anchor = content.target.getBoundingClientRect()
    const { width, height } = tooltip.getBoundingClientRect()
    const gap = 8
    const edge = 8
    const placement = anchor.bottom + gap + height <= window.innerHeight - edge ? 'bottom' : 'top'
    const left = Math.max(edge, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - edge))
    const top = Math.max(edge, Math.min(placement === 'bottom' ? anchor.bottom + gap : anchor.top - height - gap, window.innerHeight - height - edge))
    setPosition({ left, top, placement })
    const descriptions = (content.target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean)
    content.target.setAttribute('aria-describedby', [...new Set([...descriptions, id])].join(' '))
    return () => {
      const remaining = (content.target.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(value => value && value !== id)
      if (remaining.length) content.target.setAttribute('aria-describedby', remaining.join(' '))
      else content.target.removeAttribute('aria-describedby')
    }
  }, [content, id])

  return <div ref={tooltipRef} id={id} role="tooltip" className="control-tooltip" data-placement={position?.placement} data-visible={!!content && !!position} style={{ left: position?.left ?? 0, top: position?.top ?? 0 }}>
    {content && <><span>{content.label}</span>{content.shortcut && <kbd>{content.shortcut}</kbd>}</>}
  </div>
}
