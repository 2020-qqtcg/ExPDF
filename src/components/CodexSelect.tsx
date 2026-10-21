import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import './codex-select.css'

export interface CodexSelectOption {
  value: string
  label: string
  description?: string
}

interface Props {
  label: string
  value: string
  options: CodexSelectOption[]
  onChange: (value: string) => void
  disabled?: boolean
  wide?: boolean
}

interface MenuPosition { left: number; top?: number; bottom?: number; width: number; maxHeight: number }

export default function CodexSelect({ label, value, options, onChange, disabled = false, wide = false }: Props) {
  const id = useId()
  const listId = `codex-select-${id}`
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const search = useRef('')
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selectedIndex = options.findIndex(option => option.value === value)
  const selected = options[selectedIndex]
  const optionIds = options.map(option => option.value).join('\0')
  const hasDescriptions = options.some(option => option.description)

  function close(restoreFocus = false) {
    setOpen(false)
    setPosition(null)
    search.current = ''
    if (restoreFocus) trigger.current?.focus({ preventScroll: true })
  }

  function show(index = selectedIndex < 0 ? 0 : selectedIndex) {
    if (disabled || !options.length) return
    setActiveIndex(Math.max(0, Math.min(index, options.length - 1)))
    setOpen(true)
  }

  function choose(index: number) {
    const option = options[index]
    if (!option || disabled) return
    onChange(option.value)
    close(true)
  }

  useLayoutEffect(() => { close() }, [disabled, optionIds])
  useEffect(() => () => clearTimeout(searchTimer.current), [])
  useLayoutEffect(() => {
    if (!open || !trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const panel = trigger.current.closest('.codex-panel')?.getBoundingClientRect()
    let leftEdge = Math.max(8, (panel?.left ?? 0) + 12)
    let rightEdge = Math.min(window.innerWidth - 8, (panel?.right ?? window.innerWidth) - 12)
    if (rightEdge - leftEdge < 100) { leftEdge = 8; rightEdge = window.innerWidth - 8 }
    const availableWidth = Math.max(0, rightEdge - leftEdge)
    const width = Math.min(availableWidth, wide ? availableWidth : Math.max(rect.width, 160))
    const below = Math.max(0, window.innerHeight - rect.bottom - 14)
    const above = Math.max(0, rect.top - 14)
    const desiredHeight = Math.min(320, options.length * 36 + 12 + (hasDescriptions ? 56 : 0))
    const opensBelow = below >= Math.min(desiredHeight, 180) || below >= above
    const maxHeight = Math.min(desiredHeight, opensBelow ? below : above)
    setPosition({
      left: Math.max(leftEdge, Math.min(rect.left, rightEdge - width)),
      ...(opensBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      width,
      maxHeight,
    })
  }, [open, wide, optionIds, hasDescriptions, options.length])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      const target = event.target as Node | null
      if (target && !trigger.current?.contains(target) && !menu.current?.contains(target)) close()
    }
    const layoutChanged = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return
      close()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('scroll', layoutChanged, true)
    window.addEventListener('resize', layoutChanged)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('scroll', layoutChanged, true)
      window.removeEventListener('resize', layoutChanged)
    }
  }, [open])

  useLayoutEffect(() => {
    const container = list.current
    const option = container?.children.item(activeIndex) as HTMLElement | null
    if (!open || !container || !option) return
    if (option.offsetTop < container.scrollTop) container.scrollTop = option.offsetTop
    else if (option.offsetTop + option.offsetHeight > container.scrollTop + container.clientHeight) container.scrollTop = option.offsetTop + option.offsetHeight - container.clientHeight
  }, [open, activeIndex, position])

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (disabled || event.metaKey || event.ctrlKey || event.altKey) return
    const key = event.key
    if (key === 'Tab') { close(); return }
    if (key === 'Escape') {
      if (open) { event.preventDefault(); event.stopPropagation(); close(true) }
      return
    }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
      event.preventDefault(); event.stopPropagation()
      if (key === 'Home') show(0)
      else if (key === 'End') show(options.length - 1)
      else if (key === 'ArrowDown') open ? setActiveIndex(index => Math.min(options.length - 1, index + 1)) : show()
      else if (key === 'ArrowUp') open ? setActiveIndex(index => Math.max(0, index - 1)) : show()
      else if (open) choose(activeIndex)
      else show()
      return
    }
    if (key.length === 1) {
      event.preventDefault(); event.stopPropagation()
      clearTimeout(searchTimer.current)
      search.current += key.toLocaleLowerCase()
      searchTimer.current = setTimeout(() => { search.current = '' }, 700)
      const start = open ? activeIndex : selectedIndex
      const indexes = options.map((_, index) => (index + start + 1 + options.length) % options.length)
      const matches = (index: number, query: string) => options[index].label.toLocaleLowerCase().startsWith(query)
      let found = indexes.find(index => matches(index, search.current))
      if (found === undefined && search.current.length > 1) {
        search.current = key.toLocaleLowerCase()
        found = indexes.find(index => matches(index, search.current))
      }
      show(found ?? (open ? activeIndex : selectedIndex))
    }
  }

  const portalHost = trigger.current?.closest('.codex-panel') ?? (typeof document !== 'undefined' ? document.body : null)
  return <div className="codex-select" data-open={open || undefined}>
    <button
      ref={trigger}
      type="button"
      role="combobox"
      className="codex-select-trigger"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={listId}
      aria-activedescendant={open ? `${listId}-${activeIndex}` : undefined}
      disabled={disabled}
      onClick={() => open ? close() : show()}
      onKeyDown={handleKeyDown}
      onBlur={event => { if (!menu.current?.contains(event.relatedTarget as Node | null)) close() }}
    ><span className="codex-select-value">{selected?.label ?? options[0]?.label ?? '自动'}</span><ChevronDown size={13} strokeWidth={1.5} aria-hidden="true" /></button>
    {open && portalHost && createPortal(<div ref={menu} className="codex-select-menu" style={{ ...position, visibility: position ? 'visible' : 'hidden' }}>
      <div ref={list} id={listId} className="codex-select-options" role="listbox" aria-label={label}>
        {options.map((option, index) => <div
          id={`${listId}-${index}`}
          key={option.value}
          role="option"
          aria-label={option.label}
          aria-selected={option.value === value}
          className="codex-select-option"
          data-active={activeIndex === index || undefined}
          onPointerMove={() => setActiveIndex(index)}
          onPointerDown={event => event.preventDefault()}
          onClick={() => choose(index)}
        ><span>{option.label}</span><Check size={13} strokeWidth={1.8} aria-hidden="true" style={{ visibility: option.value === value ? 'visible' : 'hidden' }} /></div>)}
      </div>
      {options[activeIndex]?.description && <div className="codex-select-description">{options[activeIndex].description}</div>}
    </div>, portalHost)}
  </div>
}
