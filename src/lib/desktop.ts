export interface DesktopPdf {
  name: string
  bytes: Uint8Array
  sourceId: string
}

export type DesktopCommand = 'open' | 'save' | 'saveAs' | 'undo' | 'redo' | 'closeTab'

export interface DesktopBridge {
  platform: string
  openPdf: () => Promise<DesktopPdf | null>
  openPdfs?: () => Promise<DesktopPdf[]>
  openAgentFile: (options: { path: string; reveal?: boolean }) => Promise<{ ok: boolean; error?: string }>
  savePdf: (options: { bytes: Uint8Array; suggestedName: string; sourceId?: string; saveAs?: boolean }) => Promise<{ canceled: boolean; name?: string; sourceId?: string }>
  onOpenPdf: (callback: (pdf: DesktopPdf) => void) => () => void
  onCommand: (callback: (command: DesktopCommand) => void) => () => void
  onBeforeClose: (callback: () => Promise<void>) => () => void
  ready: () => Promise<void>
  setDocument: (document: { name: string; sourceId?: string }) => void
}

declare global {
  interface Window { folioDesktop?: DesktopBridge }
}

export function getDesktopBridge(): DesktopBridge | undefined {
  return window.folioDesktop
}
