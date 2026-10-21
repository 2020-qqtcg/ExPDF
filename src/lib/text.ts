import type { Annotation } from '../types'
import { DEFAULT_TEXT_STYLE, fontCssFamily } from './fonts'

let context: CanvasRenderingContext2D | null | undefined

/** Canvas and PDF use the same saved lines, so export never reflows an existing text box. */
export function layoutTextAnnotation(annotation: Annotation): Annotation {
  if (annotation.kind !== 'text') return annotation
  const style = { ...DEFAULT_TEXT_STYLE, ...annotation.textStyle }
  const fontSize = Number.isFinite(style.fontSize) && style.fontSize > 0 ? style.fontSize : DEFAULT_TEXT_STYLE.fontSize
  const width = Number.isFinite(style.width) && style.width > 0 ? style.width : DEFAULT_TEXT_STYLE.width
  const lineHeight = Number.isFinite(style.lineHeight) && style.lineHeight > 0 ? style.lineHeight : DEFAULT_TEXT_STYLE.lineHeight
  const rotation = Number.isFinite(style.rotation) ? style.rotation : 0
  if (context === undefined) context = document.createElement('canvas').getContext('2d')
  if (!context) throw new Error('浏览器无法创建文字排版画布。')
  context.font = `${style.italic ? 'italic ' : ''}${style.bold ? 'bold ' : ''}${fontSize}px "${fontCssFamily(style.fontId)}"`
  const measure = (value: string) => context!.measureText(value).width
  const lines: string[] = []
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined
  for (const paragraph of annotation.text.replace(/\r\n?/g, '\n').split('\n')) {
    const graphemes = segmenter ? Array.from(segmenter.segment(paragraph), (item) => item.segment) : Array.from(paragraph)
    let line = ''
    for (const character of graphemes) {
      if (line && measure(line + character) > width) {
        // Break Latin words at whitespace when possible; CJK and long words wrap by grapheme.
        const space = line.search(/\s+\S*$/u)
        if (space > 0 && /\S/u.test(character)) {
          const remainder = line.slice(space).replace(/^\s+/u, '')
          lines.push(line.slice(0, space))
          line = remainder
          if (line && measure(line + character) > width) { lines.push(line); line = '' }
        } else { lines.push(line); line = '' }
      }
      line += character
    }
    lines.push(line)
  }
  const height = Math.max(fontSize * lineHeight, lines.length * fontSize * lineHeight)
  const anchor = annotation.points?.[0] ?? { x: annotation.rects[0]?.x ?? 0, y: (annotation.rects[0]?.y ?? 0) + (annotation.rects[0]?.height ?? height) }
  const radians = rotation * Math.PI / 180
  const cosine = Math.cos(radians)
  const sine = Math.sin(radians)
  const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => ({ x: anchor.x + x * cosine + y * sine, y: anchor.y + x * sine - y * cosine }))
  const left = Math.min(...corners.map((point) => point.x))
  const bottom = Math.min(...corners.map((point) => point.y))
  return {
    ...annotation, points: [anchor], textLines: lines,
    textStyle: { ...style, fontSize, width, lineHeight, rotation },
    rects: [{ x: left, y: bottom, width: Math.max(...corners.map((point) => point.x)) - left, height: Math.max(...corners.map((point) => point.y)) - bottom }],
  }
}
