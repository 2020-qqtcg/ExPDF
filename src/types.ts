export type Tool = 'select' | 'hand' | 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'note' | 'draw' | 'text'
export type AnnotationKind = 'highlight' | 'underline' | 'strikeout' | 'squiggly' | 'note' | 'draw' | 'text'
export interface Point { x: number; y: number }
// All geometry is in the PDF page's native point coordinate system (bottom-left origin).
export interface PdfRect { x: number; y: number; width: number; height: number }
export interface TextStyle {
  fontId: string
  fontFamily: string
  fontName: string
  fontSize: number
  bold: boolean
  italic: boolean
  underline: boolean
  align: 'left' | 'center' | 'right'
  lineHeight: number
  width: number
  // Counter-clockwise rotation in native PDF coordinates.
  rotation: number
}
export interface FontDescriptor {
  id: string
  family: string
  fullName: string
  localizedFullName?: string
  aliases?: string[]
  postscriptName: string
  style: string
  weight: number
  italic: boolean
  source: 'system' | 'browser' | 'imported' | 'bundled'
}
export interface FontAsset extends FontDescriptor { bytes: Uint8Array }
export interface Annotation {
  id: string
  page: number
  kind: AnnotationKind
  color: string
  rects: PdfRect[]
  text: string
  comment: string
  points?: Point[]
  createdAt: number
  textStyle?: TextStyle
  textLines?: string[]
}
export interface CodexMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  page?: number
  quote?: string
  activities?: import('./lib/codex-agent').AgentActivity[]
}
export interface CodexContext { quote: string; page: number; version: number }
export interface CodexConversation {
  id: string
  title: string
  messages: CodexMessage[]
  threadId?: string
  createdAt: number
  updatedAt: number
}
export interface DocumentSession {
  id: string
  name: string
  bytes: Uint8Array
  desktopSourceId?: string
  annotations: Annotation[]
  bookmarks: number[]
  lastPage: number
  codexMessages?: CodexMessage[]
  codexThreadId?: string
  codexConversations?: CodexConversation[]
  activeCodexConversationId?: string
  updatedAt: number
}
export interface RecentDocument { id: string; name: string; updatedAt: number; lastPage: number }
export const ANNOTATION_LABELS: Record<AnnotationKind, string> = { highlight: '高亮', underline: '下划线', strikeout: '删除线', squiggly: '波浪线', note: '便签', draw: '自由绘制', text: '文字' }
export const COLORS = ['#f5cd52', '#8bcbb2', '#9f9bea', '#ef9fa9', '#82b6e3']
