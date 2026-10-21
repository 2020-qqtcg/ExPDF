export interface PdfDynamicTool {
  type: 'function'
  name: string
  description: string
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
}
export const PDF_TOOL_PREFIX: string
export const PDF_TOOL_LIMITS: Readonly<{ readPages: number; readChars: number; query: number; quote: number; note: number; results: number }>
export const PDF_DYNAMIC_TOOLS: PdfDynamicTool[]
export function isPdfTool(name: unknown): boolean
