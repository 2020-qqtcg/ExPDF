import { memo, useEffect, useRef, useState } from 'react'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import './pdf-page.css'

interface ThumbnailProps {
  pdf: PDFDocumentProxy
  pageNumber: number
  active: boolean
  onNavigate: (page: number) => void
}

function ThumbnailView({ pdf, pageNumber, active, onNavigate }: ThumbnailProps) {
  const rootRef = useRef<HTMLButtonElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderRef = useRef<RenderTask | null>(null)
  const rendered = useRef<{ pdf: PDFDocumentProxy; pageNumber: number } | null>(null)
  const [nearby, setNearby] = useState(false)
  const [ratio, setRatio] = useState(0.707)

  useEffect(() => {
    if (!rootRef.current) return
    const observer = new IntersectionObserver(entries => {
      const latest = entries[entries.length - 1]
      if (latest) setNearby(latest.isIntersecting)
    }, { rootMargin: '500px' })
    observer.observe(rootRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !nearby || (rendered.current?.pdf === pdf && rendered.current.pageNumber === pageNumber)) return
    let disposed = false
    const previous = renderRef.current
    const render = async () => {
      previous?.cancel()
      if (previous) await previous.promise.catch(() => {})
      const page = await pdf.getPage(pageNumber)
      if (disposed) return
      const original = page.getViewport({ scale: 1 })
      setRatio(original.width / original.height)
      const viewport = page.getViewport({ scale: 120 / original.width })
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      rendered.current = null
      canvas.width = Math.ceil(viewport.width * dpr)
      canvas.height = Math.ceil(viewport.height * dpr)
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) return
      const task = page.render({ canvas, canvasContext: context, viewport, transform: [dpr, 0, 0, dpr, 0, 0] })
      renderRef.current = task
      await task.promise
      if (!disposed) rendered.current = { pdf, pageNumber }
      if (renderRef.current === task) renderRef.current = null
    }
    void render().catch(() => {})
    return () => { disposed = true; renderRef.current?.cancel() }
  }, [pdf, pageNumber, nearby])

  return <button ref={rootRef} className={`thumbnail-button${active ? ' active' : ''}`} onClick={() => onNavigate(pageNumber)} aria-label={`跳转到第 ${pageNumber} 页`} aria-current={active ? 'page' : undefined}>
    <span className="thumbnail-preview" style={{ aspectRatio: ratio }}><canvas ref={canvasRef} className="thumbnail-canvas" aria-hidden="true" /></span>
    <span className="thumbnail-number">{pageNumber}</span>
  </button>
}

export const Thumbnail = memo(ThumbnailView)
export default Thumbnail
