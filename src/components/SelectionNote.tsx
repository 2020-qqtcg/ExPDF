import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Annotation } from '../types'
import { Note } from './ReaderIcons'
import './selection-note.css'

interface Props { annotation: Annotation; style: CSSProperties; onCommit: (comment: string) => void; onCancel: () => void }

export default function SelectionNote({ annotation, style, onCommit, onCancel }: Props) {
  const [comment, setComment] = useState(annotation.comment)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  function commit() {
    if (!comment.trim()) { setError('请输入批注内容。'); input.current?.focus(); return }
    onCommit(comment.trim())
  }
  return <section className="pdf-selection-note" role="dialog" aria-label="添加批注" style={style}
    onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onCancel() }
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.stopPropagation(); commit() }
    }}>
    <header><strong>ExPDF</strong><time dateTime={new Date(annotation.createdAt).toISOString()}>{new Date(annotation.createdAt).toLocaleDateString('zh-CN')}</time></header>
    <textarea ref={input} aria-label="标注内容" placeholder="写下你的想法…" value={comment} onChange={event => { setComment(event.target.value); setError('') }} />
    {error && <p className="selection-note-error" role="alert">{error}</p>}
    <footer><Note size={19} strokeWidth={1.2} /><span /><button type="button" onClick={onCancel}>取消</button><button type="button" className="selection-note-done" onClick={commit}>完成</button></footer>
  </section>
}
