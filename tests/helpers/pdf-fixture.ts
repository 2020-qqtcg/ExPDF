import { PDFDocument, StandardFonts } from 'pdf-lib'

export interface PdfFixture {
  name: string
  label: string
  mimeType: 'application/pdf'
  buffer: Buffer
}

/** Real, distinct multi-page PDFs that can be uploaded or dragged without user files. */
export async function makePdfFixture(name: string, label: string, pages = 3): Promise<PdfFixture> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= pages; number++) {
    const page = pdf.addPage([612, 792])
    page.drawText(`${label} - page ${number}`, { x: 52, y: 726, size: 22, font })
    page.drawText(`Independent ${label} document, annotations and conversations.`, { x: 52, y: 682, size: 14, font })
    page.drawText(`Reading position ${number} must remain in this PDF tab.`, { x: 52, y: 648, size: 14, font })
  }
  return { name, label, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) }
}
