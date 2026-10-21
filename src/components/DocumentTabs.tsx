import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import * as ReaderIcons from './ReaderIcons'
import './document-tabs.css'

export interface DocumentTabItem {
  id: string
  name: string
  saveStatus?: 'saved' | 'saving' | 'failed'
}

interface DocumentTabsProps {
  documents: DocumentTabItem[]
  activeId: string | null
  onSelect: (id: string) => void
  onClose: (id: string) => void
  onOpen: () => void
  onHistory: () => void
  children: ReactNode
}

export function DocumentTabs({ documents, activeId, onSelect, onClose, onOpen, onHistory, children }: DocumentTabsProps) {
  const stripRef = useRef<HTMLDivElement>(null)
  const activeRef = useRef<HTMLDivElement>(null)
  const documentIds = documents.map(document => document.id).join('\0')

  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const revealActiveTab = () => {
      const active = activeRef.current
      if (!active) return
      const bounds = strip.getBoundingClientRect()
      const tabBounds = active.getBoundingClientRect()
      if (tabBounds.left < bounds.left) strip.scrollLeft -= bounds.left - tabBounds.left
      else if (tabBounds.right > bounds.right) strip.scrollLeft += tabBounds.right - bounds.right
    }
    revealActiveTab()
    const observer = new ResizeObserver(revealActiveTab)
    observer.observe(strip)
    return () => observer.disconnect()
  }, [activeId, documentIds])

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !documents.length) return
    const target = event.target as HTMLElement
    const tab = target.closest<HTMLButtonElement>('[role="tab"]')
    if (!tab) return
    const index = documents.findIndex(document => document.id === tab.dataset.documentId)
    let nextIndex: number
    switch (event.key) {
      case 'ArrowLeft': nextIndex = (index - 1 + documents.length) % documents.length; break
      case 'ArrowRight': nextIndex = (index + 1) % documents.length; break
      case 'Home': nextIndex = 0; break
      case 'End': nextIndex = documents.length - 1; break
      default: return
    }
    event.preventDefault()
    event.stopPropagation()
    stripRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus({ preventScroll: true })
    onSelect(documents[nextIndex].id)
  }

  const focusId = documents.some(document => document.id === activeId) ? activeId : documents[0]?.id

  return <header className="document-tabs" aria-label="文档与外观">
    <button type="button" className="home-button" data-tooltip="最近阅读" aria-label="打开最近阅读" onClick={onHistory}><ReaderIcons.Home size={22} /></button>
    <div ref={stripRef} className="document-tab-scroll" role="tablist" aria-label="打开的 PDF" data-single={documents.length === 1 || undefined} onKeyDown={handleKeyDown}>
      {documents.map(document => {
        const active = document.id === activeId
        const status = document.saveStatus ?? 'saved'
        const saveText = status === 'saving' ? '正在保存' : status === 'failed' ? '保存失败' : '已保存'
        return <div key={document.id} ref={active ? activeRef : null} className={`document-tab${active ? ' is-active' : ''}`} title={document.name} role="presentation">
          <button type="button" className="document-tab-select" role="tab" aria-label={`切换到 PDF：${document.name}`} aria-selected={active} tabIndex={document.id === focusId ? 0 : -1} data-document-id={document.id} onClick={() => onSelect(document.id)}>
            <span className="document-tab-title">{document.name.replace(/\.pdf$/i, '')}</span>
            <span className={`document-status ${status}`} title={saveText}>{status === 'saving' ? <LoaderCircle size={11} className="spin" /> : status === 'failed' ? <span>!</span> : null}</span>
          </button>
          <button type="button" className="document-tab-close" aria-label={active ? '关闭当前 PDF' : `关闭 PDF：${document.name}`} data-tooltip="关闭文档" onClick={() => onClose(document.id)}><ReaderIcons.Close size={13} /></button>
        </div>
      })}
    </div>
    <button type="button" className="icon-button new-document" aria-label="打开其他 PDF" data-tooltip="打开其他 PDF" onClick={onOpen}><ReaderIcons.Plus size={18} /></button>
    {children}
  </header>
}
