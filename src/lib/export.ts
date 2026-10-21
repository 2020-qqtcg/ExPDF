import { PDFDocument, PDFHexString, PDFName, PDFString } from 'pdf-lib'
import type { PDFFont } from 'pdf-lib'
import type { Annotation, FontAsset, PdfRect, Point } from '../types'
import { ensureFont } from './fonts'
import { SQUIGGLY_STROKE_WIDTH, TEXT_MARKUP_STROKE_WIDTH, squigglyPath } from './markup'

function colorComponents(color: string): number[] {
  const hex = /^#[\da-f]{6}$/i.test(color) ? color.slice(1) : 'f5cd52'
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255)
}

function validRect(rect: PdfRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0 && rect.height > 0
}

function boundsFor(rects: PdfRect[], points: Point[], padding: number): PdfRect | undefined {
  const xs = rects.flatMap((rect) => [rect.x, rect.x + rect.width]).concat(points.map((point) => point.x))
  const ys = rects.flatMap((rect) => [rect.y, rect.y + rect.height]).concat(points.map((point) => point.y))
  if (!xs.length) return undefined
  const x = Math.min(...xs) - padding
  const y = Math.min(...ys) - padding
  return {
    x, y,
    width: Math.max(1, Math.max(...xs) - x + padding),
    height: Math.max(1, Math.max(...ys) - y + padding),
  }
}

const n = (value: number) => Number(value.toFixed(4)).toString()

interface EmbeddedFont { font: PDFFont; asset: FontAsset; resourceName: string }

function textAppearance(annotation: Annotation, bounds: PdfRect, embedded: EmbeddedFont): string[] {
  const style = annotation.textStyle!
  const anchor = annotation.points![0]
  const lines = annotation.textLines ?? annotation.text.split(/\r?\n/)
  const angle = style.rotation * Math.PI / 180
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const skew = style.italic && !embedded.asset.italic ? 0.2126 : 0
  const bold = style.bold && embedded.asset.weight < 600
  const localPoint = (x: number, y: number) => ({
    x: anchor.x + x * cos + y * sin - bounds.x,
    y: anchor.y + x * sin - y * cos - bounds.y,
  })
  const commands = [`${n(Math.max(0.2, style.fontSize * 0.025))} w`, 'BT', `/${embedded.resourceName} ${n(style.fontSize)} Tf`, `${bold ? 2 : 0} Tr`]
  const underlines: string[] = []
  for (const [index, line] of lines.entries()) {
    const width = embedded.font.widthOfTextAtSize(line, style.fontSize)
    const x = style.align === 'center' ? (style.width - width) / 2 : style.align === 'right' ? style.width - width : 0
    const baseline = style.fontSize * 0.85 + index * style.fontSize * style.lineHeight
    const point = localPoint(x, baseline)
    commands.push(`${n(cos)} ${n(sin)} ${n(-sin + skew * cos)} ${n(cos + skew * sin)} ${n(point.x)} ${n(point.y)} Tm`, `${embedded.font.encodeText(line).toString()} Tj`)
    if (style.underline && line.length) {
      const start = localPoint(x, baseline + style.fontSize * 0.1)
      const end = localPoint(x + width, baseline + style.fontSize * 0.1)
      underlines.push(`${n(start.x)} ${n(start.y)} m ${n(end.x)} ${n(end.y)} l S`)
    }
  }
  commands.push('ET')
  if (underlines.length) commands.push(`${n(Math.max(0.5, style.fontSize * 0.045))} w`, ...underlines)
  return commands
}

/** Keeps the original page contents and annotations intact; new marks remain editable PDF annotations. */
export async function exportAnnotatedPdf(bytes: Uint8Array, annotations: Annotation[], resolveFont: (id: string) => Promise<FontAsset> = ensureFont): Promise<Uint8Array> {
  const document = await PDFDocument.load(bytes)
  const pages = document.getPages()
  const context = document.context
  const subtypes = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly', note: 'Text', draw: 'Ink', text: 'FreeText' }
  const embeddedFonts = new Map<string, EmbeddedFont>()

  async function embedTextFont(annotation: Annotation): Promise<EmbeddedFont> {
    const style = annotation.textStyle
    const anchor = annotation.points?.[0]
    if (!style || !anchor || ![anchor.x, anchor.y, style.fontSize, style.width, style.lineHeight, style.rotation].every(Number.isFinite)
      || style.fontSize <= 0 || style.width <= 0 || style.lineHeight <= 0) {
      throw new Error('文字标注缺少有效的字体或定位信息，请重新编辑后导出。')
    }
    let embedded = embeddedFonts.get(style.fontId)
    if (!embedded) {
      const asset = await resolveFont(style.fontId)
      try {
        const fontkit = (await import('@pdf-lib/fontkit')).default
        // Select a specific face from a TTC/dfont collection before pdf-lib subsets it.
        const parsed = fontkit.create(asset.bytes)
        const faces = (parsed as unknown as { fonts?: typeof parsed[] }).fonts
        const face = faces ? faces.find(candidate => candidate.postscriptName === asset.postscriptName) : parsed
        if (!face || typeof face.hasGlyphForCodePoint !== 'function') throw new Error('找不到指定字体字面')
        const cffFace = face as typeof face & {
          cff?: boolean
          'CFF '?: { isCIDFont: boolean }
          directory: { tables: Record<string, { offset: number; length: number }> }
          stream: { buffer: Uint8Array }
        }
        const cffDirectory = cffFace.directory.tables['CFF ']
        const parsedCff = cffFace['CFF ']
        // Preserve raw CFF when its CID subsetter is unsafe or a valid CFF FontDict
        // contains operators fontkit cannot parse (e.g. PingFang's FontMatrix).
        const fullCff = !!cffDirectory && (!parsedCff || parsedCff.isCIDFont === true)
        const cffTable = fullCff ? cffDirectory : undefined
        if (fullCff && (!cffTable || cffTable.offset + cffTable.length > cffFace.stream.buffer.length)) throw new Error('字体数据不完整')
        const fontBytes = cffTable ? cffFace.stream.buffer.subarray(cffTable.offset, cffTable.offset + cffTable.length) : asset.bytes
        if (fullCff) cffFace.cff = true
        document.registerFontkit({ create: () => face })
        const font = await document.embedFont(fontBytes, { subset: !fullCff })
        embedded = { font, asset, resourceName: `FT${embeddedFonts.size}` }
        embeddedFonts.set(style.fontId, embedded)
      } catch {
        throw new Error(`无法读取字体“${asset.fullName || style.fontName}”，请改用其他字体或导入 TTF / OTF 字体。`)
      }
    }
    const supported = new Set(embedded.font.getCharacterSet())
    for (const character of new Set((annotation.textLines ?? annotation.text.split(/\r?\n/)).join(''))) {
      const codePoint = character.codePointAt(0)!
      if (!supported.has(codePoint)) {
        throw new Error(`字体“${embedded.asset.fullName}”不包含字符“${character}”（U+${codePoint.toString(16).toUpperCase()}），请选择支持此文字的字体。`)
      }
    }
    return embedded
  }

  for (const annotation of annotations) {
    const page = pages[annotation.page - 1]
    if (!page || !subtypes[annotation.kind]) continue
    const rects = annotation.rects.filter(validRect)
    const points = (annotation.points ?? []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    const padding = annotation.kind === 'text' ? (annotation.textStyle?.fontSize ?? 0) * 0.25 : annotation.kind === 'draw' ? 2 : annotation.kind === 'highlight' || annotation.kind === 'note' ? 0 : 1.5
    const bounds = boundsFor(rects, annotation.kind === 'draw' ? points : [], padding)
    if (!bounds || (annotation.kind === 'draw' && points.length < 2)) continue
    const color = colorComponents(annotation.color)
    const colorString = color.map(n).join(' ')
    const commands: string[] = ['q', `${colorString} rg`, `${colorString} RG`]
    const embedded = annotation.kind === 'text' ? await embedTextFont(annotation) : undefined

    if (annotation.kind === 'text') {
      try { commands.push(...textAppearance(annotation, bounds, embedded!)) } catch {
        throw new Error(`字体“${embedded!.asset.fullName}”无法正确排版这段文字，请改用其他字体后重试。`)
      }
    } else if (annotation.kind === 'highlight') {
      commands.push('/GS0 gs')
      for (const rect of rects) {
        commands.push(`${n(rect.x - bounds.x)} ${n(rect.y - bounds.y)} ${n(rect.width)} ${n(rect.height)} re f`)
      }
    } else if (annotation.kind === 'squiggly') {
      commands.push(`${n(SQUIGGLY_STROKE_WIDTH)} w`, '1 J', '1 j')
      const local = (point: Point) => `${n(point.x - bounds.x)} ${n(point.y - bounds.y)}`
      for (const rect of rects) {
        const wave = squigglyPath(rect)
        commands.push(`${local(wave.start)} m`)
        for (const curve of wave.curves) commands.push(`${local(curve.control1)} ${local(curve.control2)} ${local(curve.end)} c`)
        commands.push('S')
      }
    } else if (annotation.kind === 'underline' || annotation.kind === 'strikeout') {
      commands.push(`${n(TEXT_MARKUP_STROKE_WIDTH)} w`, '1 J')
      for (const rect of rects) {
        const y = rect.y - bounds.y + (annotation.kind === 'underline' ? Math.max(0.8, rect.height * 0.06) : rect.height * 0.48)
        commands.push(`${n(rect.x - bounds.x)} ${n(y)} m ${n(rect.x + rect.width - bounds.x)} ${n(y)} l S`)
      }
    } else if (annotation.kind === 'draw') {
      commands.push('1.8 w', '1 J', '1 j', `${n(points[0].x - bounds.x)} ${n(points[0].y - bounds.y)} m`)
      for (const point of points.slice(1)) commands.push(`${n(point.x - bounds.x)} ${n(point.y - bounds.y)} l`)
      commands.push('S')
    } else {
      // An appearance stream makes the standard sticky-note icon visible in viewers without icon synthesis.
      const w = bounds.width
      const h = bounds.height
      const fold = Math.min(w, h) * 0.27
      commands.push(`0.8 w 0.38 0.31 0.12 RG 1 1 m ${n(w - fold)} 1 l ${n(w - 1)} ${n(fold)} l ${n(w - 1)} ${n(h - 1)} l 1 ${n(h - 1)} l h B`)
      commands.push(`1 0.98 0.87 rg ${n(w - fold)} 1 m ${n(w - fold)} ${n(fold)} l ${n(w - 1)} ${n(fold)} l h B`)
      commands.push('1 w 0.46 0.36 0.15 RG')
      for (const fraction of [0.68, 0.49]) {
        commands.push(`${n(w * 0.23)} ${n(h * fraction)} m ${n(w * 0.73)} ${n(h * fraction)} l S`)
      }
    }
    commands.push('Q')

    const resources = embedded ? { Font: { [embedded.resourceName]: embedded.font.ref } } : annotation.kind === 'highlight'
      ? { ExtGState: { GS0: { Type: 'ExtGState', ca: 0.28, CA: 0.28, BM: 'Multiply' } } }
      : {}
    const appearance = context.register(context.flateStream(commands.join('\n'), {
      Type: 'XObject', Subtype: 'Form', FormType: 1,
      BBox: [0, 0, bounds.width, bounds.height], Resources: resources,
    }))
    const created = new Date(annotation.createdAt)
    const date = PDFString.fromDate(Number.isNaN(created.getTime()) ? new Date() : created)
    const dictionary = context.obj({
      Type: 'Annot', Subtype: subtypes[annotation.kind],
      Rect: [bounds.x, bounds.y, bounds.x + bounds.width, bounds.y + bounds.height],
      C: color, F: 4, P: page.ref,
      NM: PDFHexString.fromText(annotation.id),
      T: PDFHexString.fromText('ExPDF'),
      Contents: PDFHexString.fromText(annotation.kind === 'text' ? annotation.text : annotation.comment || annotation.text || ''),
      CreationDate: date, M: date,
      AP: { N: appearance },
    })

    if (['highlight', 'underline', 'strikeout', 'squiggly'].includes(annotation.kind)) {
      dictionary.set(PDFName.of('QuadPoints'), context.obj(rects.flatMap((rect) => [
        rect.x, rect.y + rect.height, rect.x + rect.width, rect.y + rect.height,
        rect.x, rect.y, rect.x + rect.width, rect.y,
      ])))
    }
    if (annotation.kind === 'highlight') dictionary.set(PDFName.of('CA'), context.obj(0.28))
    if (embedded) {
      const style = annotation.textStyle!
      dictionary.set(PDFName.of('DA'), PDFString.of(`/${embedded.resourceName} ${n(style.fontSize)} Tf ${colorString} rg`))
      dictionary.set(PDFName.of('DR'), context.obj(resources))
      dictionary.set(PDFName.of('Q'), context.obj({ left: 0, center: 1, right: 2 }[style.align]))
      dictionary.set(PDFName.of('DS'), PDFHexString.fromText(`font-family:"${style.fontFamily.replace(/["\\]/g, '')}";font-size:${n(style.fontSize)}pt;font-weight:${style.bold ? 'bold' : 'normal'};font-style:${style.italic ? 'italic' : 'normal'};text-decoration:${style.underline ? 'underline' : 'none'};text-align:${style.align};line-height:${n(style.lineHeight)};`))
      dictionary.set(PDFName.of('IT'), PDFName.of('FreeText'))
      dictionary.set(PDFName.of('BS'), context.obj({ W: 0 }))
    }
    if (annotation.kind === 'note') {
      dictionary.set(PDFName.of('Name'), PDFName.of('Comment'))
      dictionary.set(PDFName.of('Open'), context.obj(false))
    }
    if (annotation.kind === 'draw') {
      dictionary.set(PDFName.of('InkList'), context.obj([points.flatMap((point) => [point.x, point.y])]))
      dictionary.set(PDFName.of('BS'), context.obj({ W: 1.8, S: 'S' }))
    }
    page.node.addAnnot(context.register(dictionary))
  }
  return document.save()
}

export function downloadFile(bytes: Uint8Array, filename: string, mime = 'application/pdf'): void {
  const blob = new Blob([Uint8Array.from(bytes).buffer], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
