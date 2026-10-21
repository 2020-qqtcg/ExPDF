import type { CSSProperties } from 'react'
import * as Icons from './ReaderIcons'
import './selection-toolbar.css'

export type SelectionMarkup = 'highlight' | 'strikeout' | 'underline' | 'squiggly'
export const SELECTION_MARKUP_COLORS: Record<SelectionMarkup, string> = { highlight: '#ffff00', strikeout: '#e06c5c', underline: '#7de6c7', squiggly: '#7d8ce1' }

interface Props {
  style: CSSProperties
  compact: boolean
  copying: boolean
  canAsk: boolean
  onAsk: () => void
  onMarkup: (kind: SelectionMarkup) => void
  onNote: () => void
  onCopy: () => void
}

export default function SelectionToolbar({ style, compact, copying, canAsk, onAsk, onMarkup, onNote, onCopy }: Props) {
  return <div className={`pdf-selection-toolbar${compact ? ' is-compact' : ''}`} role="toolbar" aria-label="选中文字工具" style={style}
    onPointerDown={event => { event.preventDefault(); event.stopPropagation() }}
    onPointerUp={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}>
    <button type="button" className="selection-ai" aria-label="问 Codex" data-tooltip="问 Codex" disabled={!canAsk} onClick={onAsk}><span className="codex-orb"><Icons.Sparkles size={20} /></span><span className="selection-ai-label">Codex AI</span></button>
    <span className="selection-toolbar-divider" aria-hidden="true" />
    {([{ kind: 'highlight', label: '高亮', icon: Icons.Highlight }, { kind: 'strikeout', label: '删除线', icon: Icons.Strikeout }, { kind: 'underline', label: '下划线', icon: Icons.Underline }, { kind: 'squiggly', label: '波浪线', icon: Icons.Squiggly }] as const).map(item => <button type="button" key={item.kind} aria-label={item.label} data-tooltip={item.label} onClick={() => onMarkup(item.kind)}><item.icon size={20} strokeWidth={1.2} /></button>)}
    <button type="button" aria-label="批注" data-tooltip="批注" onClick={onNote}><Icons.Note size={20} strokeWidth={1.2} /></button>
    <span className="selection-toolbar-divider" aria-hidden="true" />
    <button type="button" className="selection-reference" aria-label="编辑" disabled><Icons.Edit size={20} strokeWidth={1.2} /></button>
    <button type="button" className="selection-reference" aria-label="添加书签" disabled><Icons.AddBookmark size={20} strokeWidth={1.2} /></button>
    <button type="button" className="selection-reference" aria-label="朗读" disabled><Icons.ReadAloud size={20} strokeWidth={1.2} /></button>
    <button type="button" aria-label="复制" data-tooltip="复制" disabled={copying} onClick={onCopy}><Icons.Copy size={20} strokeWidth={1.2} /></button>
  </div>
}
