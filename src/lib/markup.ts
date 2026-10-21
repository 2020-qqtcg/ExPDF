import type { PdfRect, Point } from '../types'

export const TEXT_MARKUP_STROKE_WIDTH = 0.8
export const SQUIGGLY_STROKE_WIDTH = 0.8

interface CubicSegment { control1: Point; control2: Point; end: Point }

/** Shared screen/export geometry, in native PDF coordinates with a bottom-left origin. */
export function squigglyPath(rect: PdfRect): { start: Point; curves: CubicSegment[] } {
  const baseline = rect.y + Math.min(rect.height * 0.5, Math.max(0.8, rect.height * 0.06))
  const amplitude = 0.8
  const frequency = 2 * Math.PI / 4.8
  // Quarter-wave cubic Hermite segments keep the curve smooth, including a partial final wave.
  const count = Math.min(4096, Math.max(1, Math.ceil(rect.width / 1.2)))
  const curves: CubicSegment[] = []
  for (let index = 0; index < count; index++) {
    const x0 = rect.width * index / count
    const x1 = rect.width * (index + 1) / count
    const third = (x1 - x0) / 3
    const y0 = baseline + amplitude * Math.sin(x0 * frequency)
    const y1 = baseline + amplitude * Math.sin(x1 * frequency)
    curves.push({
      control1: { x: rect.x + x0 + third, y: y0 + amplitude * frequency * Math.cos(x0 * frequency) * third },
      control2: { x: rect.x + x1 - third, y: y1 - amplitude * frequency * Math.cos(x1 * frequency) * third },
      end: { x: rect.x + x1, y: y1 },
    })
  }
  return { start: { x: rect.x, y: baseline }, curves }
}
