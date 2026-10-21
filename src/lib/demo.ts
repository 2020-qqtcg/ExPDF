import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import type { PDFFont, PDFPage, RGB } from 'pdf-lib'
import type { Annotation } from '../types'

const PAGE_WIDTH = 612
const PAGE_HEIGHT = 792
const ink = rgb(0.16, 0.22, 0.19)
const muted = rgb(0.43, 0.48, 0.43)
const cream = rgb(0.976, 0.969, 0.941)
const sage = rgb(0.49, 0.59, 0.51)
const paleSage = rgb(0.86, 0.89, 0.83)
const terracotta = rgb(0.77, 0.48, 0.36)

function text(page: PDFPage, value: string, x: number, y: number, font: PDFFont, size = 12, color: RGB = ink) {
  page.drawText(value, { x, y, font, size, color })
}

function paragraph(page: PDFPage, value: string, x: number, y: number, font: PDFFont, width = 470, size = 12, lineHeight = 21): number {
  let line = ''
  let cursor = y
  for (const word of value.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (line && font.widthOfTextAtSize(candidate, size) > width) {
      text(page, line, x, cursor, font, size)
      cursor -= lineHeight
      line = word
    } else line = candidate
  }
  if (line) text(page, line, x, cursor, font, size)
  return cursor - lineHeight
}

function pageBase(document: PDFDocument, number: number, sans: PDFFont): PDFPage {
  const page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT])
  page.drawRectangle({ x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT, color: cream })
  text(page, 'SLOW LIVING  /  VOL. 01', 64, 742, sans, 8.3, muted)
  text(page, 'THE ART OF PAYING ATTENTION', 64, 39, sans, 7.4, muted)
  text(page, `${number.toString().padStart(2, '0')}  /  04`, 507, 39, sans, 7.4, muted)
  page.drawLine({ start: { x: 64, y: 58 }, end: { x: 548, y: 58 }, thickness: 0.6, color: paleSage })
  return page
}

/** A real, selectable four-page PDF, bundled as generated vector art and embedded standard fonts. */
export async function createDemoDocument(): Promise<{ name: string; bytes: Uint8Array; annotations: Annotation[] }> {
  const document = await PDFDocument.create()
  document.setTitle('The art of paying attention')
  document.setAuthor('ExPDF')
  document.setSubject('A field guide to a more intentional everyday')
  document.setCreator('ExPDF')
  const serif = await document.embedFont(StandardFonts.TimesRoman)
  const italic = await document.embedFont(StandardFonts.TimesRomanItalic)
  const sans = await document.embedFont(StandardFonts.Helvetica)
  const bold = await document.embedFont(StandardFonts.HelveticaBold)

  const cover = pageBase(document, 1, sans)
  text(cover, 'The art of', 62, 640, serif, 60)
  text(cover, 'paying attention.', 62, 576, serif, 60)
  text(cover, 'A field guide to a more intentional everyday.', 65, 535, sans, 12.4, muted)

  // Quiet, geometric still life: an arch, a vessel, a sun, and a single branch.
  cover.drawEllipse({ x: 302, y: 299, xScale: 147, yScale: 139, color: paleSage })
  cover.drawRectangle({ x: 205, y: 192, width: 134, height: 111, color: sage })
  cover.drawEllipse({ x: 272, y: 303, xScale: 67, yScale: 67, color: sage })
  cover.drawRectangle({ x: 243, y: 191, width: 58, height: 111, color: cream })
  cover.drawEllipse({ x: 272, y: 302, xScale: 29, yScale: 29, color: cream })
  cover.drawCircle({ x: 393, y: 373, size: 36, color: rgb(0.85, 0.70, 0.41) })
  cover.drawRectangle({ x: 330, y: 192, width: 62, height: 83, color: terracotta })
  cover.drawEllipse({ x: 361, y: 275, xScale: 31, yScale: 8, color: rgb(0.63, 0.37, 0.28) })
  cover.drawLine({ start: { x: 361, y: 271 }, end: { x: 377, y: 347 }, thickness: 2, color: ink })
  cover.drawEllipse({ x: 365, y: 311, xScale: 17, yScale: 6, rotate: degrees(-32), color: sage })
  cover.drawEllipse({ x: 385, y: 329, xScale: 17, yScale: 6, rotate: degrees(34), color: sage })
  cover.drawEllipse({ x: 368, y: 342, xScale: 14, yScale: 5.5, rotate: degrees(-38), color: sage })
  cover.drawLine({ start: { x: 157, y: 191 }, end: { x: 453, y: 191 }, thickness: 1, color: muted })
  text(cover, 'MAKE ROOM FOR WHAT MATTERS.', 65, 118, bold, 8.6, muted)
  text(cover, 'An invitation to slow down, look closer, and find beauty in the ordinary.', 65, 98, sans, 9.4, muted)

  const thinking = pageBase(document, 2, sans)
  text(thinking, '01   /   THE PRACTICE OF NOTICING', 64, 695, bold, 8.3, muted)
  text(thinking, 'Space to think.', 62, 631, serif, 48)
  let y = paragraph(thinking, 'The day often arrives already full. Before we have opened the curtains, there are messages to answer, decisions to make, and a small queue of things asking for our attention. It is easy to mistake this motion for a meaningful life.', 65, 586, sans)
  y = paragraph(thinking, 'Slowing down begins with a different question: what is already here? The warmth of a cup between your hands. A familiar street in a different light. A conversation that deserves a little more time.', 65, y - 19, sans)
  thinking.drawRectangle({ x: 64, y: 295, width: 484, height: 115, color: paleSage })
  text(thinking, 'Attention is the beginning', 87, 366, italic, 25)
  text(thinking, 'of a more meaningful life.', 87, 335, italic, 25)
  y = paragraph(thinking, 'We do not need to make every moment extraordinary. We only need to be present enough to notice the moments that are. A little space in the day gives our thoughts somewhere to settle.', 65, 256, sans)
  paragraph(thinking, 'Try this today: put your phone away for ten minutes. Walk without a destination. Listen to the end of a sentence. Let one small thing receive your undivided attention.', 65, y - 19, sans)

  const less = pageBase(document, 3, sans)
  text(less, '02   /   CHOOSING WITH CARE', 64, 695, bold, 8.3, muted)
  text(less, 'Less, but better.', 62, 631, serif, 48)
  paragraph(less, 'An intentional life is shaped by what we choose to keep. These small practices create room for the people, objects, and rituals that make everyday life feel like our own.', 65, 584, sans)
  const tips = [
    ['01', 'Make a little room.', 'Start with one surface, one drawer, or one hour of your week. Keep what serves you. Let the rest become space.'],
    ['02', 'Choose a daily ritual.', 'A quiet breakfast, a page of a book, or a walk after dinner can be an anchor. Repetition turns an ordinary action into a moment of care.'],
    ['03', 'Leave something unfinished.', 'A day does not need to be perfectly optimized to be well lived. Give yourself permission to stop before everything is done.'],
    ['04', 'Keep what feels like you.', 'Notice the things you reach for again and again. A few well-loved things can offer more than a room full of possibilities.'],
  ]
  for (const [index, [number, title, body]] of tips.entries()) {
    const top = 475 - index * 94
    text(less, number, 65, top, serif, 20, sage)
    text(less, title, 109, top + 1, bold, 12.3)
    paragraph(less, body, 109, top - 23, sans, 430, 10.8, 17)
    if (index < tips.length - 1) less.drawLine({ start: { x: 109, y: top - 65 }, end: { x: 548, y: top - 65 }, thickness: 0.5, color: paleSage })
  }

  const beginning = pageBase(document, 4, sans)
  text(beginning, '03   /   AN INVITATION', 64, 695, bold, 8.3, muted)
  text(beginning, 'A small beginning.', 62, 631, serif, 46)
  paragraph(beginning, 'Change rarely arrives as a grand gesture. More often, it begins quietly: with a pause before saying yes, a walk taken slowly, or a little more kindness toward the person we are becoming.', 65, 584, sans)
  beginning.drawCircle({ x: 307, y: 365, size: 91, color: paleSage })
  beginning.drawCircle({ x: 307, y: 365, size: 60, borderColor: sage, borderWidth: 1 })
  text(beginning, 'Begin', 264, 373, italic, 31)
  text(beginning, 'where you are.', 245, 342, italic, 24)
  text(beginning, 'ONE THING TO TRY', 65, 210, bold, 8.8, muted)
  paragraph(beginning, 'At the end of today, write down one thing you noticed. It does not have to be impressive. A color. A sound. A moment of connection. Let it be enough.', 65, 181, sans)

  const createdAt = Date.now()
  const annotations: Annotation[] = [
    {
      id: 'demo-highlight-cover', page: 1, kind: 'highlight', color: '#f5cd52',
      rects: [{ x: 65, y: 533, width: sans.widthOfTextAtSize('A field guide to a more intentional everyday.', 12.4), height: 14 }],
      text: 'A field guide to a more intentional everyday.', comment: '慢下来，把注意力留给真正重要的事。', createdAt,
    },
    {
      id: 'demo-highlight-attention', page: 2, kind: 'highlight', color: '#8bcbb2',
      rects: [
        { x: 87, y: 362, width: italic.widthOfTextAtSize('Attention is the beginning', 25), height: 27 },
        { x: 87, y: 331, width: italic.widthOfTextAtSize('of a more meaningful life.', 25), height: 27 },
      ],
      text: 'Attention is the beginning of a more meaningful life.', comment: '专注，是让生活变得更有意义的开始。', createdAt: createdAt + 1,
    },
    {
      id: 'demo-note-beginning', page: 1, kind: 'note', color: '#f5cd52',
      rects: [{ x: 496, y: 534, width: 22, height: 24 }],
      text: '', comment: '欢迎使用 ExPDF。试试选中文字，再点击高亮或划线；也可以直接添加便签。阅读记录与标注会自动保存在本机。', createdAt: createdAt + 2,
    },
  ]
  return { name: 'The art of paying attention.pdf', bytes: await document.save(), annotations }
}
