import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { AlignCenter, AlignLeft, AlignRight, ArrowUpRight, Bold, Bookmark, BookOpen, Check, ChevronLeft, ChevronRight, CircleHelp, FilePlus2, FileText, FolderOpen, Italic, List, LoaderCircle, Maximize2, MessageSquare, Minus, Plus, RotateCw, Search, Trash2, Underline, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import PdfPage from './components/PdfPage'
import Thumbnail from './components/Thumbnail'
import CodexPanel from './components/CodexPanel'
import ControlTooltip from './components/ControlTooltip'
import { DocumentTabs } from './components/DocumentTabs'
import * as ReaderIcons from './components/ReaderIcons'
import { createDemoDocument } from './lib/demo'
import { downloadFile, exportAnnotatedPdf } from './lib/export'
import { DEFAULT_TEXT_STYLE, ensureFont, fontLabel, getAvailableFonts, importFont, matchesFontSearch, requestBrowserFonts } from './lib/fonts'
import { layoutTextAnnotation } from './lib/text'
import { getDocumentId, listRecentDocuments, loadSession, saveSession } from './lib/storage'
import { createCodexConversation, restoreCodexConversations, updateCodexConversationMessages } from './lib/codex-conversations'
import { createPdfToolDispatcher } from './lib/codex-pdf-tools'
import { getDesktopBridge } from './lib/desktop'
import type { DesktopCommand, DesktopPdf } from './lib/desktop'
import type { Annotation, CodexContext, CodexMessage, DocumentSession, FontDescriptor, RecentDocument, TextStyle, Tool } from './types'
import { ANNOTATION_LABELS, COLORS } from './types'

GlobalWorkerOptions.workerSrc = workerUrl
interface LoadedDocument { id: string; name: string; bytes: Uint8Array; pdf: PDFDocumentProxy; desktopSourceId?: string }
interface OutlineEntry { title: string; page: number; level: number }
interface ReadingAnchor { page: HTMLElement; x: number; y: number; viewportX: number; viewportY: number; rotation: number; atPointer?: boolean }
interface TabReadingPoint { page: number; x: number; y: number; viewportX: number; viewportY: number }
interface DocumentTab {
  document: LoadedDocument
  session: DocumentSession
  undo: Annotation[][]
  redo: Annotation[][]
  outline: OutlineEntry[]
  textCache: string[] | null
  view: {
    scale: number; rotation: number; fitsWidth: boolean; scrollTop: number | null; scrollLeft: number
    readingPoint?: TabReadingPoint
    leftPanel: boolean; rightPanel: boolean; codexOpen: boolean; leftTab: 'pages' | 'outline' | 'bookmarks'
    tool: Tool; query: string; showSearch: boolean; filter: string; context: CodexContext | null; question: string
  }
}
const OPEN_TABS_KEY = 'folio:open-documents'
const MemoPdfPage = memo(PdfPage)
const EMPTY_ANNOTATIONS: Annotation[] = []
// Event handlers stay current without invalidating every page during autosave or navigation.
function useReaderEvent<Args extends unknown[], Result>(handler: (...args: Args) => Result) {
  const latest = useRef(handler)
  latest.current = handler
  return useCallback((...args: Args) => latest.current(...args), [])
}
const TOOLS: { id: Tool; icon: LucideIcon; label: string; shortcut: string }[] = [
  { id: 'select', icon: ReaderIcons.Select, label: '选择文本', shortcut: 'V' },
  { id: 'hand', icon: ReaderIcons.Hand, label: '拖动阅读', shortcut: 'H' },
  { id: 'highlight', icon: ReaderIcons.Highlight, label: '高亮', shortcut: 'A' },
  { id: 'underline', icon: ReaderIcons.Underline, label: '下划线', shortcut: 'U' },
  { id: 'strikeout', icon: ReaderIcons.Strikeout, label: '删除线', shortcut: 'S' },
  { id: 'note', icon: ReaderIcons.Note, label: '便签', shortcut: 'N' },
  { id: 'draw', icon: ReaderIcons.Pen, label: '自由绘制', shortcut: 'D' },
  { id: 'text', icon: ReaderIcons.Text, label: '添加文字', shortcut: 'T' },
]
function IconButton({ icon: Icon, label, active, className = '', ...props }: { icon: LucideIcon; label: string; active?: boolean; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`icon-button ${active ? 'active' : ''} ${className}`} data-tooltip={label} aria-label={label} aria-pressed={active} onMouseDown={event => { if (event.currentTarget.closest('.text-format-bar')) event.preventDefault() }} {...props}><Icon size={18} strokeWidth={1.2} /></button>
}
function Modal({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { const el = dialog.current; el?.showModal(); return () => el?.close() }, [])
  return <dialog ref={dialog} className={`modal ${className}`} onCancel={e => { e.preventDefault(); onClose() }} onClick={e => { if (e.target === e.currentTarget) onClose() }}><div className="modal-heading"><h2>{title}</h2><IconButton icon={X} label="关闭" onClick={onClose} /></div>{children}</dialog>
}

export default function App() {
  const [desktop] = useState(getDesktopBridge)
  const [windowActive, setWindowActive] = useState(() => document.hasFocus())
  useEffect(() => {
    const updateWindowActive = () => setWindowActive(document.hasFocus())
    window.addEventListener('focus', updateWindowActive)
    window.addEventListener('blur', updateWindowActive)
    return () => { window.removeEventListener('focus', updateWindowActive); window.removeEventListener('blur', updateWindowActive) }
  }, [])
  const [doc, setDoc] = useState<LoadedDocument | null>(null)
  const [openTabs, setOpenTabs] = useState<LoadedDocument[]>([])
  const tabs = useRef(new Map<string, DocumentTab>())
  const documentQueue = useRef<Promise<unknown>>(Promise.resolve())
  const restoringTabs = useRef(false)
  const pendingTabScroll = useRef<{ id: string; top: number | null; left: number; page: number; readingPoint?: TabReadingPoint } | null>(null)
  const sessionSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const codexBeforeLeave = useRef<(() => string) | null>(null)
  const [codexDraft, setCodexDraft] = useState('')
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [bookmarks, setBookmarks] = useState<number[]>([])
  const [undoStack, setUndoStack] = useState<Annotation[][]>([])
  const [redoStack, setRedoStack] = useState<Annotation[][]>([])
  const [page, setPage] = useState(1)
  const [pageInput, setPageInput] = useState('1')
  const cancelPageNumber = useRef(false)
  const [scale, setScale] = useState(1)
  const fitsWidth = useRef(true)
  const [rotation, setRotation] = useState(0)
  const [tool, setTool] = useState<Tool>('select')
  const [color, setColor] = useState(COLORS[0])
  const [openToolMenu, setOpenToolMenu] = useState<'select' | 'markup' | null>(null)
  const [lastMarkup, setLastMarkup] = useState<Tool>('highlight')
  const [controlsVisible, setControlsVisible] = useState(true)
  const controlsTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wakeControls = useCallback(() => {
    setControlsVisible(true); clearTimeout(controlsTimer.current)
    controlsTimer.current = setTimeout(() => setControlsVisible(false), 1800)
  }, [])
  useEffect(() => { wakeControls(); return () => clearTimeout(controlsTimer.current) }, [wakeControls])
  const [fonts, setFonts] = useState<FontDescriptor[]>([])
  const [textStyle, setTextStyle] = useState<TextStyle>(DEFAULT_TEXT_STYLE)
  const [textColor, setTextColor] = useState('#333333')
  const [textDraft, setTextDraft] = useState<Annotation | null>(null)
  const [fontBusy, setFontBusy] = useState(false)
  const [fontSearch, setFontSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [leftPanel, setLeftPanelState] = useState(() => window.innerWidth > 1000)
  const [rightPanel, setRightPanelState] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    try { return localStorage.getItem('folio:theme') === 'light' ? 'light' : 'dark' } catch { return 'dark' }
  })
  useEffect(() => { try { localStorage.setItem('folio:theme', theme) } catch { /* Theme remains usable without storage. */ } }, [theme])
  useEffect(() => {
    const compact = window.matchMedia('(max-width: 900px)')
    const collapsePanels = () => { if (compact.matches) { setLeftPanel(false); if (!currentView.current.codexOpen) setRightPanel(false) } }
    compact.addEventListener('change', collapsePanels)
    return () => compact.removeEventListener('change', collapsePanels)
  }, [])
  const [codexOpen, setCodexOpenState] = useState(false)
  const [panelResizeVersion, setPanelResizeVersion] = useState(0)
  const [codexContext, setCodexContext] = useState<CodexContext | null>(null)
  const [codexChats, setCodexChats] = useState(() => restoreCodexConversations())
  const codexChatsRef = useRef(codexChats)
  const codexConversation = codexChats.conversations.find(chat => chat.id === codexChats.activeId)!
  const codexMessages = codexConversation.messages
  const codexThreadId = codexConversation.threadId
  const codexContextVersion = useRef(0)
  const [leftTab, setLeftTab] = useState<'pages' | 'outline' | 'bookmarks'>('pages')
  const [outline, setOutline] = useState<OutlineEntry[]>([])
  const [filter, setFilter] = useState('all')
  const [showSearch, setShowSearch] = useState(false)
  const [query, setQuery] = useState('')
  const [searchPages, setSearchPages] = useState<{ page: number; count: number }[]>([])
  const [searchIndex, setSearchIndex] = useState(0)
  const [searching, setSearching] = useState(false)
  const [recents, setRecents] = useState<RecentDocument[]>([])
  const [recentOpen, setRecentOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving' | 'failed'>('saved')
  const [toast, setToast] = useState('')
  const [editor, setEditor] = useState<Annotation | null>(null)
  const [editText, setEditText] = useState('')
  const [help, setHelp] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [password, setPassword] = useState<{ submit: (password: string) => void; cancel: () => void; wrong: boolean } | null>(null)
  const [passwordInput, setPasswordInput] = useState('')
  const viewer = useRef<HTMLDivElement>(null)
  const physicalControl = useRef(false)
  const wheelZoom = useRef<{ frame: number; scale: number | null; point: { x: number; y: number } }>({ frame: 0, scale: null, point: { x: 0, y: 0 } })
  const readingAnchor = useRef<ReadingAnchor | null>(null)
  const currentView = useRef({ scale, rotation, leftPanel, rightPanel, codexOpen, tool, page })
  currentView.current = { scale, rotation, leftPanel, rightPanel, codexOpen, tool, page }
  const fileInput = useRef<HTMLInputElement>(null)
  const fontInput = useRef<HTMLInputElement>(null)
  const textDraftRef = useRef<Annotation | null>(null)
  const annotationsRef = useRef<Annotation[]>([])
  textDraftRef.current = textDraft
  annotationsRef.current = annotations
  const searchInput = useRef<HTMLInputElement>(null)
  const moreMenu = useRef<HTMLDetailsElement>(null)
  const sessionRef = useRef<DocumentSession | null>(null)
  const loadVersion = useRef(0)
  const docRef = useRef<LoadedDocument | null>(null)
  const searchVersion = useRef(0)
  const restoreSearchPosition = useRef(false)
  const textCache = useRef<string[] | null>(null)
  const didBoot = useRef(false)
  const nativeOpenPending = useRef(false)
  const exportPending = useRef(false)
  const saveCompletion = useRef<Promise<void> | null>(null)
  const notify = useCallback((message: string) => setToast(message), [])

  const goToPage = useCallback((value: number, smooth = true) => {
    if (!docRef.current) return
    const next = Math.min(docRef.current.pdf.numPages, Math.max(1, Math.round(value)))
    setPage(next); setPageInput(String(next))
    document.getElementById(`page-${next}`)?.scrollIntoView({ behavior: smooth && !window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'instant', block: 'start' })
  }, [])

  function rememberReadingPosition(point?: { x: number; y: number }) {
    const root = viewer.current
    if (!root) return
    const bounds = root.getBoundingClientRect()
    const viewportX = point ? Math.max(0, Math.min(root.clientWidth, point.x - bounds.left)) : root.clientWidth / 2
    const viewportY = point ? Math.max(0, Math.min(root.clientHeight, point.y - bounds.top)) : root.clientHeight / 3
    const targetY = bounds.top + viewportY
    const pages = root.querySelectorAll<HTMLElement>('.pdf-page')
    let candidate: HTMLElement | undefined
    let closest = Infinity
    for (const element of pages) {
      const top = element.offsetTop - root.scrollTop + bounds.top
      const distance = Math.max(top - targetY, targetY - top - element.offsetHeight, 0)
      if (distance < closest) { candidate = element; closest = distance }
      if (top > targetY) break
    }
    if (!candidate) return
    const rect = candidate.getBoundingClientRect()
    readingAnchor.current = { page: candidate, x: (bounds.left + viewportX - rect.left) / rect.width, y: (targetY - rect.top) / rect.height, viewportX, viewportY, rotation: currentView.current.rotation, atPointer: !!point }
  }
  const resizeCodexPanel = useReaderEvent(() => {
    if (!readingAnchor.current) rememberReadingPosition()
    setPanelResizeVersion(version => version + 1)
  })
  function setLeftPanel(value: React.SetStateAction<boolean>) {
    const next = typeof value === 'function' ? value(currentView.current.leftPanel) : value
    if (next !== currentView.current.leftPanel) rememberReadingPosition()
    setLeftPanelState(next)
  }
  function setRightPanel(value: React.SetStateAction<boolean>) {
    const next = typeof value === 'function' ? value(currentView.current.rightPanel) : value
    if (!next && currentView.current.rightPanel && currentView.current.codexOpen) setCodexDraft(codexBeforeLeave.current?.() ?? codexDraft)
    if (next !== currentView.current.rightPanel) rememberReadingPosition()
    setRightPanelState(next)
  }
  function setCodexOpen(value: React.SetStateAction<boolean>) {
    const next = typeof value === 'function' ? value(currentView.current.codexOpen) : value
    if (!next && currentView.current.rightPanel && currentView.current.codexOpen) setCodexDraft(codexBeforeLeave.current?.() ?? codexDraft)
    if (next !== currentView.current.codexOpen) rememberReadingPosition()
    setCodexOpenState(next)
  }
  function cancelWheelZoom() {
    cancelAnimationFrame(wheelZoom.current.frame)
    wheelZoom.current.frame = 0
    wheelZoom.current.scale = null
  }
  function changeZoom(value: number, fitting = false, point?: { x: number; y: number }) {
    cancelWheelZoom()
    if (!Number.isFinite(value)) return
    fitsWidth.current = fitting
    const next = Math.min(5, Math.max(.35, value))
    if (next === currentView.current.scale) return
    rememberReadingPosition(point)
    setScale(next)
  }
  const applyWheelZoom = useReaderEvent((value: number, point: { x: number; y: number }) => {
    changeZoom(value, false, point)
    wakeControls()
  })
  useEffect(() => {
    const trackControl = (event: KeyboardEvent) => { physicalControl.current = event.ctrlKey }
    const reset = () => { physicalControl.current = false; cancelWheelZoom() }
    window.addEventListener('keydown', trackControl)
    window.addEventListener('keyup', trackControl)
    window.addEventListener('blur', reset)
    return () => {
      reset()
      window.removeEventListener('keydown', trackControl)
      window.removeEventListener('keyup', trackControl)
      window.removeEventListener('blur', reset)
    }
  }, [])
  useEffect(() => {
    const root = viewer.current
    if (!root || !doc) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || event.defaultPrevented || (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]'))) return
      // Chromium sends trackpad pinches as Ctrl+wheel. Cancel before batching so
      // the browser never magnifies the application chrome, even at our limits.
      event.preventDefault()
      const mode = event.deltaMode
      const delta = event.deltaY
      if (!Number.isFinite(delta) || delta === 0) return
      fitsWidth.current = false
      const pinch = !physicalControl.current && mode === WheelEvent.DOM_DELTA_PIXEL
      const ticks = mode === WheelEvent.DOM_DELTA_PIXEL ? delta / 100 : mode === WheelEvent.DOM_DELTA_LINE ? delta : Math.sign(delta)
      const exponent = pinch ? -delta / 100 : -ticks * Math.log(1.1)
      const pending = wheelZoom.current
      pending.scale = Math.min(5, Math.max(.35, (pending.scale ?? currentView.current.scale) * Math.exp(Math.max(-10, Math.min(10, exponent)))))
      pending.point = { x: event.clientX, y: event.clientY }
      if (!pending.frame) pending.frame = requestAnimationFrame(() => {
        const value = pending.scale
        const point = pending.point
        pending.frame = 0; pending.scale = null
        if (value !== null) applyWheelZoom(value, point)
      })
    }
    root.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      cancelWheelZoom()
      root.removeEventListener('wheel', onWheel)
    }
  }, [doc?.id, applyWheelZoom])
  function rotatePage() { cancelWheelZoom(); rememberReadingPosition(); setRotation(value => (value + 90) % 360) }
  useLayoutEffect(() => {
    const anchor = readingAnchor.current
    readingAnchor.current = null
    const root = viewer.current
    if (!anchor?.page.isConnected || !root) return
    let { x, y } = anchor
    for (let turns = ((rotation - anchor.rotation + 360) % 360) / 90; turns > 0; turns--) [x, y] = [1 - y, x]
    const bounds = root.getBoundingClientRect()
    const rect = anchor.page.getBoundingClientRect()
    const viewportX = Math.min(anchor.viewportX, root.clientWidth / (anchor.atPointer ? 1 : 2))
    root.scrollTo({ left: root.scrollLeft + rect.left + rect.width * x - bounds.left - viewportX, top: root.scrollTop + rect.top + rect.height * y - bounds.top - anchor.viewportY, behavior: 'instant' })
  }, [scale, rotation, leftPanel, rightPanel, codexOpen, tool, panelResizeVersion])

  const enqueueDocumentAction = useCallback((action: () => Promise<void>) => {
    const pending = documentQueue.current.catch(() => {}).then(action)
    documentQueue.current = pending
    return pending
  }, [])
  const persistOpenTabs = useCallback(() => {
    setOpenTabs([...tabs.current.values()].map(tab => tab.document))
    if (restoringTabs.current) return
    try {
      const activeId = docRef.current?.id ?? null
      localStorage.setItem(OPEN_TABS_KEY, JSON.stringify({ ids: [...tabs.current.keys()], activeId }))
      if (activeId) localStorage.setItem('folio:last-document', activeId)
      else localStorage.removeItem('folio:last-document')
    } catch { /* Tabs still work when local storage is unavailable. */ }
  }, [])
  const registerCodexLeave = useCallback((handler: () => string) => {
    codexBeforeLeave.current = handler
    return () => { if (codexBeforeLeave.current === handler) codexBeforeLeave.current = null }
  }, [])
  const captureCurrentTab = useReaderEvent((leaving = false) => {
    const current = docRef.current
    const tab = current && tabs.current.get(current.id)
    if (!current || !tab) return
    clearTimeout(sessionSaveTimer.current)
    const hadTextDraft = !!textDraftRef.current
    const previousAnnotations = annotationsRef.current
    const nextAnnotations = commitTextDraft()
    const question = leaving ? codexBeforeLeave.current?.() ?? codexDraft : codexDraft
    const chats = codexChatsRef.current
    const active = chats.conversations.find(chat => chat.id === chats.activeId)!
    rememberReadingPosition()
    const anchor = readingAnchor.current
    const root = viewer.current
    const readingPoint = anchor && root ? { page: Number(anchor.page.dataset.pageNumber), x: anchor.x, y: anchor.y, viewportX: anchor.viewportX / root.clientWidth, viewportY: anchor.viewportY / root.clientHeight } : undefined
    readingAnchor.current = null
    const session: DocumentSession = {
      id: current.id, name: current.name, bytes: current.bytes, desktopSourceId: current.desktopSourceId,
      annotations: nextAnnotations, bookmarks, lastPage: currentView.current.page,
      codexMessages: active.messages, codexThreadId: active.threadId,
      codexConversations: chats.conversations, activeCodexConversationId: chats.activeId, updatedAt: Date.now(),
    }
    sessionRef.current = session
    tabs.current.set(current.id, {
      document: current, session,
      undo: previousAnnotations === nextAnnotations ? undoStack : [...undoStack.slice(-49), previousAnnotations],
      redo: previousAnnotations === nextAnnotations ? redoStack : [], outline, textCache: textCache.current,
      view: {
        scale, rotation, fitsWidth: fitsWidth.current, scrollTop: viewer.current?.scrollTop ?? 0, scrollLeft: viewer.current?.scrollLeft ?? 0, readingPoint,
        leftPanel, rightPanel, codexOpen, leftTab, tool: hadTextDraft ? 'select' : tool,
        query, showSearch, filter, context: codexContext, question,
      },
    })
  })
  const activateDocumentTab = useReaderEvent(async (id: string) => {
    if (docRef.current?.id === id) { setRecentOpen(false); return }
    const target = tabs.current.get(id)
    if (!target) return
    await saveCompletion.current
    captureCurrentTab(true)
    await flushSession()
    cancelWheelZoom(); readingAnchor.current = null
    cancelAnimationFrame(scrollFrame.current); scrollFrame.current = 0
    docRef.current = target.document; sessionRef.current = target.session
    annotationsRef.current = target.session.annotations
    const chats = restoreCodexConversations(target.session)
    codexChatsRef.current = chats; setCodexChats(chats)
    setDoc(target.document); setAnnotations(target.session.annotations); setBookmarks(target.session.bookmarks)
    setUndoStack(target.undo); setRedoStack(target.redo); setOutline(target.outline); textCache.current = target.textCache
    setScale(target.view.scale); setRotation(target.view.rotation); fitsWidth.current = target.view.fitsWidth
    setPage(target.session.lastPage); setPageInput(String(target.session.lastPage))
    setLeftPanelState(target.view.leftPanel); setRightPanelState(target.view.rightPanel); setCodexOpenState(target.view.codexOpen)
    restoreSearchPosition.current = true
    setLeftTab(target.view.leftTab); setTool(target.view.tool); setQuery(target.view.query); setShowSearch(target.view.showSearch); setFilter(target.view.filter)
    setCodexContext(target.view.context); setCodexDraft(target.view.question)
    setSelectedId(null); setEditor(null); setTextDraft(null); setOpenToolMenu(null); closeMoreMenu(); setSearchPages([]); setRecentOpen(false); setSaveStatus('saved')
    pendingTabScroll.current = { id, top: target.view.scrollTop, left: target.view.scrollLeft, page: target.session.lastPage, readingPoint: target.view.readingPoint }
    persistOpenTabs()
    // Let the new page containers and their fit-width layout settle before restoring the viewport.
    await new Promise<void>(resolve => {
      let completed = false
      let frame = 0
      const restore = () => {
        if (completed) return
        completed = true; clearTimeout(timeout); cancelAnimationFrame(frame)
        if (docRef.current?.id === id) {
          const position = pendingTabScroll.current
          pendingTabScroll.current = null
          const root = viewer.current
          const point = position?.readingPoint
          const sheet = point && root?.querySelector<HTMLElement>(`#page-${point.page}`)
          if (root && sheet && point) {
            const bounds = root.getBoundingClientRect(), rect = sheet.getBoundingClientRect()
            root.scrollTo({ top: root.scrollTop + rect.top + rect.height * point.y - bounds.top - root.clientHeight * point.viewportY, left: root.scrollLeft + rect.left + rect.width * point.x - bounds.left - root.clientWidth * point.viewportX, behavior: 'instant' })
          } else if (position?.top !== null && position) root?.scrollTo({ top: position.top, left: position.left, behavior: 'instant' })
          else goToPage(target.session.lastPage, false)
        }
        resolve()
      }
      // Hidden windows can pause animation frames; document saves must still finish.
      const timeout = setTimeout(restore, 120)
      frame = requestAnimationFrame(() => { frame = requestAnimationFrame(restore) })
    })
  })
  function selectDocumentTab(id: string) { void enqueueDocumentAction(() => activateDocumentTab(id)) }

  async function flushSession() {
    const current = sessionRef.current
    if (current) await saveSession(current).catch(() => {})
  }

  async function showHistory() {
    closeMoreMenu()
    setHistoryQuery('')
    setRecentOpen(true)
    await flushSession()
    try { setRecents(await listRecentDocuments()) }
    catch { notify('无法读取历史 PDF，请检查浏览器本地存储是否可用。') }
  }

  async function openRecentDocument(id: string) {
    if (id === docRef.current?.id) { setRecentOpen(false); return }
    if (tabs.current.has(id)) { selectDocumentTab(id); setRecentOpen(false); return }
    try {
      const stored = await loadSession(id)
      if (stored) await openDocument(stored.bytes, stored.name, [], stored.desktopSourceId)
      else notify('此本地记录已不存在，请重新打开文件。')
    } catch { notify('无法读取此历史 PDF，请尝试重新打开原文件。') }
  }

  const openDocumentNow = useCallback(async (bytes: Uint8Array, name: string, initialAnnotations: Annotation[] = [], desktopSourceId?: string) => {
    const version = ++loadVersion.current
    cancelWheelZoom()
    readingAnchor.current = null
    setLoading(true); setRecentOpen(false)
    let pdf: PDFDocumentProxy | null = null
    try {
      const id = await getDocumentId(bytes)
      if (tabs.current.has(id)) { await activateDocumentTab(id); return }
      const restored = await loadSession(id).catch(() => undefined)
      const task = getDocument({ data: bytes.slice(), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' })
      task.onPassword = (updatePassword: (password: string) => void, reason: number) => {
        setPasswordInput('')
        setPassword({ submit: value => { setPassword(null); updatePassword(value) }, cancel: () => { setPassword(null); void task.destroy() }, wrong: reason === 2 })
      }
      pdf = await task.promise
      const firstPageViewport = (await pdf.getPage(1)).getViewport({ scale: 1 })
      if (version !== loadVersion.current) { void pdf.loadingTask.destroy(); return }
      const sourceId = desktop ? desktopSourceId : undefined
      const next = { id, name, bytes, pdf, desktopSourceId: sourceId }
      const chats = restoreCodexConversations(restored)
      const activeChat = chats.conversations.find(chat => chat.id === chats.activeId)!
      const initialPage = Math.max(1, Math.min(pdf.numPages, restored?.lastPage ?? 1))
      const session: DocumentSession = { id, name, bytes, desktopSourceId: sourceId, annotations: restored?.annotations ?? initialAnnotations, bookmarks: restored?.bookmarks ?? [], lastPage: initialPage, codexMessages: activeChat.messages, codexThreadId: activeChat.threadId, codexConversations: chats.conversations, activeCodexConversationId: chats.activeId, updatedAt: Date.now() }
      await saveSession(session).catch(() => {})
      tabs.current.set(id, { document: next, session, undo: [], redo: [], outline: [], textCache: null, view: {
        scale: Math.min(5, Math.max(.35, ((viewer.current?.clientWidth ?? 900) - 40) / firstPageViewport.width)), rotation: 0, fitsWidth: true, scrollTop: null, scrollLeft: 0,
        leftPanel: currentView.current.leftPanel, rightPanel: false, codexOpen: false, leftTab: 'pages', tool: 'select', query: '', showSearch: false, filter: 'all', context: null, question: '',
      } })
      await activateDocumentTab(id)
      const currentPdf = pdf
      void currentPdf.getOutline().then(async tree => {
        const entries: OutlineEntry[] = []
        async function walk(items: NonNullable<typeof tree>, level: number) {
          for (const item of items) {
            let destination = item.dest
            if (typeof destination === 'string') destination = await currentPdf.getDestination(destination)
            let targetPage = 1
            if (Array.isArray(destination)) {
              const ref = destination[0]
              targetPage = typeof ref === 'number' ? ref + 1 : await currentPdf.getPageIndex(ref) + 1
            }
            entries.push({ title: item.title, page: targetPage, level })
            if (item.items?.length) await walk(item.items, level + 1)
          }
        }
        if (tree) await walk(tree, 0)
        const tab = tabs.current.get(id)
        if (tab) tab.outline = entries
        if (docRef.current?.id === id) setOutline(entries)
      }).catch(() => {})
    } catch (error) {
      if (version !== loadVersion.current) return
      const message = error instanceof Error ? error.message : String(error)
      notify(/password/i.test(message) ? '未能解锁文档，请重新打开并输入正确密码。' : '无法打开此文件。请确认它是有效且完整的 PDF。')
    } finally { if (version === loadVersion.current) setLoading(false) }
  }, [desktop, activateDocumentTab, notify])
  const openDocument = useCallback((bytes: Uint8Array, name: string, initialAnnotations: Annotation[] = [], sourceId?: string) => enqueueDocumentAction(() => openDocumentNow(bytes, name, initialAnnotations, sourceId)), [enqueueDocumentAction, openDocumentNow])

  const openDesktopPdf = useReaderEvent((file: DesktopPdf) => openDocument(new Uint8Array(file.bytes), file.name, [], file.sourceId))
  const desktopCommand = useReaderEvent((command: DesktopCommand) => {
    if (command === 'open') void requestOpenFile()
    else if (command === 'closeTab') void closeCurrentDocument()
    else if (command === 'undo' || command === 'redo') {
      const target = document.activeElement
      if (target instanceof HTMLElement && (['INPUT', 'TEXTAREA'].includes(target.tagName) || target.isContentEditable)) document.execCommand(command)
      else if (command === 'undo') undo()
      else redo()
    }
    else void exportPdf(command === 'saveAs')
  })
  const beforeDesktopClose = useReaderEvent(async () => {
    password?.cancel()
    await documentQueue.current.catch(() => {})
    await saveCompletion.current
    captureCurrentTab(true)
    await flushSession()
    persistOpenTabs()
  })
  useEffect(() => {
    if (!desktop) return
    const stopOpen = desktop.onOpenPdf(file => { void openDesktopPdf(file) })
    const stopCommand = desktop.onCommand(desktopCommand)
    const stopClose = desktop.onBeforeClose(beforeDesktopClose)
    return () => { stopOpen(); stopCommand(); stopClose() }
  }, [desktop, openDesktopPdf, desktopCommand, beforeDesktopClose])

  useEffect(() => {
    if (didBoot.current) return
    didBoot.current = true
    void (async () => {
      let workspace: { ids: string[]; activeId?: string } | undefined
      try {
        const value = JSON.parse(localStorage.getItem(OPEN_TABS_KEY) ?? 'null') as { ids?: unknown; activeId?: unknown } | null
        if (Array.isArray(value?.ids) && value.ids.every(id => typeof id === 'string')) workspace = { ids: [...new Set(value.ids as string[])], activeId: typeof value.activeId === 'string' ? value.activeId : undefined }
      } catch { /* Older installations restore their last document below. */ }
      if (workspace) {
        restoringTabs.current = true
        for (const id of workspace.ids) {
          const stored = await loadSession(id).catch(() => undefined)
          if (stored) await openDocument(stored.bytes, stored.name, [], stored.desktopSourceId)
        }
        if (workspace.activeId) await enqueueDocumentAction(() => activateDocumentTab(workspace!.activeId!))
        restoringTabs.current = false; persistOpenTabs(); setLoading(false)
      } else {
        let last: DocumentSession | undefined
        try { const id = localStorage.getItem('folio:last-document'); if (id) last = await loadSession(id) } catch { /* Fall back to sample. */ }
        if (last) await openDocument(last.bytes, last.name, [], last.desktopSourceId)
        else { const demo = await createDemoDocument(); await openDocument(demo.bytes, demo.name, demo.annotations) }
      }
      setRecents(await listRecentDocuments().catch(() => []))
    })().catch(() => { setLoading(false); notify('初始化失败，请尝试打开一个 PDF 文件。') }).finally(() => {
      if (desktop) void desktop.ready().catch(() => notify('桌面文件接入暂不可用，请尝试重新打开文件。'))
    })
  }, [desktop, openDocument, enqueueDocumentAction, activateDocumentTab, persistOpenTabs, notify])

  useEffect(() => {
    if (!doc) return
    const snapshot = { id: doc.id, name: doc.name, bytes: doc.bytes, desktopSourceId: doc.desktopSourceId, annotations, bookmarks, lastPage: page, codexMessages, codexThreadId, codexConversations: codexChats.conversations, activeCodexConversationId: codexChats.activeId, updatedAt: Date.now() }
    sessionRef.current = snapshot
    const tab = tabs.current.get(doc.id)
    if (tab) tab.session = snapshot
    setSaveStatus('saving')
    const timer = setTimeout(() => {
      void saveSession(snapshot).then(() => { if (sessionRef.current === snapshot) setSaveStatus('saved'); return listRecentDocuments() }).then(setRecents).catch(() => { if (sessionRef.current === snapshot) setSaveStatus('failed') })
    }, 400)
    sessionSaveTimer.current = timer
    return () => clearTimeout(timer)
  }, [doc, annotations, bookmarks, page, codexChats, codexMessages, codexThreadId])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''), 4500); return () => clearTimeout(timer) }, [toast])
  useEffect(() => { setPageInput(String(page)) }, [page])
  useEffect(() => { document.title = doc ? `${doc.name} · ExPDF` : 'ExPDF · PDF 阅读器' }, [doc])
  useEffect(() => { desktop?.setDocument({ name: doc?.name ?? 'ExPDF', sourceId: doc?.desktopSourceId }) }, [desktop, doc])
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!moreMenu.current?.contains(event.target as Node)) moreMenu.current?.removeAttribute('open')
      if (!(event.target instanceof Element && event.target.closest('.tool-dropdown'))) setOpenToolMenu(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])
  useEffect(() => {
    void getAvailableFonts().then(setFonts).catch(() => notify('本机字体列表暂不可用，仍可使用内置字体或导入字体文件。'))
  }, [notify])
  useEffect(() => {
    const ids = [...new Set(annotations.filter(item => item.kind === 'text').map(item => item.textStyle?.fontId).filter((id): id is string => !!id))]
    for (const id of ids) void ensureFont(id).catch(() => notify('部分文字字体暂时无法读取，请在文字工具中重新选择字体。'))
  }, [doc?.id, annotations, notify])
  useEffect(() => { if (showSearch) searchInput.current?.focus() }, [showSearch])
  useEffect(() => {
    const save = () => { if (document.visibilityState === 'hidden') void flushSession() }
    document.addEventListener('visibilitychange', save)
    return () => document.removeEventListener('visibilitychange', save)
  }, [])

  function changeAnnotations(next: Annotation[]) {
    const current = annotationsRef.current
    setUndoStack(stack => [...stack.slice(-49), current]); setRedoStack([]); setAnnotations(next)
    annotationsRef.current = next
    if (sessionRef.current) sessionRef.current = { ...sessionRef.current, annotations: next }
  }
  function setActiveTextDraft(next: Annotation | null) {
    textDraftRef.current = next
    setTextDraft(next)
  }
  function cancelTextDraft() { rememberReadingPosition(); setActiveTextDraft(null); setSelectedId(null); setTool('select') }
  function commitTextDraft(): Annotation[] {
    const draft = textDraftRef.current
    if (!draft) return annotationsRef.current
    let result = annotationsRef.current
    if (draft.text.trim()) {
      const next = layoutTextAnnotation(draft)
      result = result.some(item => item.id === next.id) ? result.map(item => item.id === next.id ? next : item) : [...result, next]
      changeAnnotations(result)
    } else if (result.some(item => item.id === draft.id)) {
      result = result.filter(item => item.id !== draft.id)
      changeAnnotations(result)
    }
    cancelTextDraft()
    return result
  }
  function applyTextStyle(patch: Partial<TextStyle>) {
    setTextStyle(current => ({ ...current, ...patch }))
    const draft = textDraftRef.current
    if (draft?.textStyle) setActiveTextDraft(layoutTextAnnotation({ ...draft, textStyle: { ...draft.textStyle, ...patch } }))
  }
  async function chooseFont(id: string, format?: Partial<TextStyle>) {
    setFontBusy(true)
    try {
      const font = await ensureFont(id)
      applyTextStyle({ fontId: font.id, fontFamily: font.family, fontName: font.fullName, bold: font.weight >= 600, italic: font.italic, ...format })
    } catch (error) { notify(error instanceof Error ? error.message : '无法读取所选字体，请尝试其他字体。') }
    finally { setFontBusy(false) }
  }
  function toggleTextFormat(kind: 'bold' | 'italic') {
    const current = textDraftRef.current?.textStyle ?? textStyle
    const next = { bold: current.bold, italic: current.italic, [kind]: !current[kind] }
    const candidates = fonts.filter(font => font.family === current.fontFamily && font.italic === next.italic)
    candidates.sort((a, b) => Math.abs(a.weight - (next.bold ? 700 : 400)) - Math.abs(b.weight - (next.bold ? 700 : 400)))
    if (candidates[0] && candidates[0].id !== current.fontId) void chooseFont(candidates[0].id, next)
    else applyTextStyle(next)
  }
  async function activateTool(id: Tool) {
    setOpenToolMenu(null)
    if (['highlight', 'underline', 'strikeout'].includes(id)) setLastMarkup(id)
    if (textDraftRef.current) commitTextDraft()
    setSelectedId(null)
    if (id === 'text') {
      setFontBusy(true)
      try { await ensureFont(textStyle.fontId); if (currentView.current.tool !== id) rememberReadingPosition(); setTool(id) }
      catch (error) { notify(error instanceof Error ? error.message : '文字字体无法载入，请重试。') }
      finally { setFontBusy(false) }
    } else { if (currentView.current.tool !== id) rememberReadingPosition(); setTool(id) }
  }
  async function readBrowserFonts() {
    setFontBusy(true)
    try { const localFonts = await requestBrowserFonts(); setFonts(current => [...new Map([...current, ...localFonts].map(font => [font.id, font])).values()]); notify(`已读取 ${localFonts.length} 个本机字体字形。`) }
    catch (error) { notify(error instanceof Error ? error.message : '此浏览器不能直接读取字体，请导入字体文件。') }
    finally { setFontBusy(false) }
  }
  async function importFontFiles(files: FileList | null) {
    if (!files?.length) return
    setFontBusy(true)
    try {
      const added: FontDescriptor[] = []
      for (const file of Array.from(files)) added.push(...await importFont(file))
      setFonts(current => [...new Map([...current, ...added].map(font => [font.id, font])).values()])
      if (added[0]) await chooseFont(added[0].id)
    } catch (error) { notify(error instanceof Error ? error.message : '字体导入失败，请使用 TTF、OTF 或 TTC 文件。') }
    finally { setFontBusy(false) }
  }
  function addAnnotation(annotation: Annotation) {
    if (annotation.kind === 'text') {
      if (textDraftRef.current && textDraftRef.current.id !== annotation.id) commitTextDraft()
      const next = { ...annotation, color: annotation.text ? annotation.color : textColor, textStyle: annotation.textStyle ?? textStyle }
      setActiveTextDraft(layoutTextAnnotation(next)); setTextStyle(next.textStyle); setTextColor(next.color); setSelectedId(null); setTool('text')
      void ensureFont(next.textStyle.fontId).then(() => {
        if (textDraftRef.current?.id === next.id) setActiveTextDraft(layoutTextAnnotation(textDraftRef.current))
      }).catch(error => notify(error instanceof Error ? error.message : '字体读取失败。'))
      return
    }
    setSelectedId(null)
    if (annotation.kind === 'note' && !annotation.comment.trim()) { setEditor(annotation); setEditText(''); return }
    changeAnnotations([...annotations, annotation])
  }
  function updateAnnotation(annotation: Annotation) {
    if (!annotations.some(item => item.id === annotation.id)) return
    changeAnnotations(annotations.map(item => item.id === annotation.id ? annotation : item))
    setSelectedId(null)
  }
  function openEditor(annotation: Annotation) { if (annotation.kind === 'text') { addAnnotation(annotation); return }; setSelectedId(annotation.id); setEditor(annotation); setEditText(annotation.comment) }
  function closeEditor() { setEditor(null); setSelectedId(null) }
  function saveEditor() {
    if (!editor) return
    if (editor.kind === 'note' && !editText.trim()) { notify('写下一点想法，再保存便签。'); return }
    const next = { ...editor, comment: editText.trim() }
    changeAnnotations(annotations.some(a => a.id === next.id) ? annotations.map(a => a.id === next.id ? next : a) : [...annotations, next])
    closeEditor()
    if (next.kind === 'note') setTool('select')
  }
  function undo() {
    const previous = undoStack.at(-1); if (!previous) return
    setRedoStack(stack => [...stack, annotations]); setAnnotations(previous); setUndoStack(stack => stack.slice(0, -1)); setSelectedId(null)
  }
  function redo() {
    const next = redoStack.at(-1); if (!next) return
    setUndoStack(stack => [...stack, annotations]); setAnnotations(next); setRedoStack(stack => stack.slice(0, -1)); setSelectedId(null)
  }
  const openFile = useCallback(async (file?: File) => {
    if (!file) return
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) { notify('请选择 PDF 格式的文件。'); return }
    await enqueueDocumentAction(async () => {
      try { await openDocumentNow(new Uint8Array(await file.arrayBuffer()), file.name) }
      catch { notify('无法读取此文件，请重试。') }
    })
  }, [enqueueDocumentAction, openDocumentNow, notify])
  async function openFiles(files: File[]) { await Promise.all(files.map(file => openFile(file))) }
  async function requestOpenFile() {
    if (!desktop) { fileInput.current?.click(); return }
    if (nativeOpenPending.current) return
    nativeOpenPending.current = true
    try {
      if (desktop.openPdfs) await Promise.all((await desktop.openPdfs()).map(file => openDesktopPdf(file)))
      else { const file = await desktop.openPdf(); if (file) await openDesktopPdf(file) }
    } catch { notify('无法打开此文件，请重试。') }
    finally { nativeOpenPending.current = false }
  }
  async function exportPdf(saveAs = false) {
    const current = docRef.current
    if (!current || loading || exportPending.current) return
    exportPending.current = true
    let resolveSave!: () => void
    const completion = new Promise<void>(resolve => { resolveSave = resolve })
    saveCompletion.current = completion
    setExporting(true)
    try {
      const exportAnnotations = commitTextDraft()
      const bytes = await exportAnnotatedPdf(current.bytes, exportAnnotations)
      if (desktop) {
        const result = await desktop.savePdf({ bytes, suggestedName: current.name, sourceId: current.desktopSourceId, saveAs: saveAs || !current.desktopSourceId })
        if (result.canceled) return
        const name = result.name ?? current.name
        const desktopSourceId = result.sourceId ?? current.desktopSourceId
        // Keep the original source bytes: every save embeds the current marks once.
        if (docRef.current === current) {
          const next = { ...current, name, desktopSourceId }
          docRef.current = next; setDoc(next)
          const tab = tabs.current.get(current.id)
          if (tab) tab.document = next
          persistOpenTabs()
        }
        let historySaved = true
        try {
          const stored = sessionRef.current?.id === current.id ? sessionRef.current : await loadSession(current.id)
          if (stored) {
            const next = { ...stored, name, desktopSourceId, updatedAt: Date.now() }
            if (sessionRef.current?.id === current.id) sessionRef.current = next
            await saveSession(next)
          }
          setRecents(await listRecentDocuments())
        } catch { historySaved = false }
        notify(historySaved ? 'PDF 已保存，标注与便签已写入文件。' : 'PDF 已保存，本机阅读记录暂未更新。')
      } else {
        downloadFile(bytes, `${current.name.replace(/\.pdf$/i, '')} - 已标注.pdf`)
        notify('PDF 已导出，标注与便签已写入文件。')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      notify(/encrypt/i.test(message) ? `此 PDF 已加密，暂不支持${desktop ? '保存' : '导出'}。可继续阅读和在本机保存标注。` : /字体|文字标注|字符|字面/.test(message) ? message : `${desktop ? '保存' : '导出'}失败，请重试。此文件可能限制了编辑。`)
    }
    finally {
      exportPending.current = false; setExporting(false)
      if (saveCompletion.current === completion) saveCompletion.current = null
      resolveSave()
    }
  }
  function toggleBookmark() {
    const exists = bookmarks.includes(page)
    setBookmarks(exists ? bookmarks.filter(p => p !== page) : [...bookmarks, page].sort((a, b) => a - b))
    notify(exists ? '已移除本页书签' : '已添加本页书签')
  }
  function askCodex(quote: string, sourcePage: number) {
    if (!quote.trim() || !docRef.current) return
    commitTextDraft()
    setSelectedId(null); setTool('select')
    setCodexContext({ quote: quote.trim(), page: sourcePage, version: ++codexContextVersion.current })
    setCodexOpen(true); setRightPanel(true)
  }
  function consumeCodexContext(version: number) {
    setCodexContext(current => current?.version === version ? null : current)
  }
  function commitCodexChats(next: typeof codexChats) {
    codexChatsRef.current = next; setCodexChats(next)
    const active = next.conversations.find(chat => chat.id === next.activeId)!
    if (sessionRef.current) sessionRef.current = { ...sessionRef.current, codexConversations: next.conversations, activeCodexConversationId: next.activeId, codexMessages: active.messages, codexThreadId: active.threadId }
  }
  function changeCodexMessages(documentId: string, conversationId: string, next: CodexMessage[]) {
    if (docRef.current?.id !== documentId) return
    const current = codexChatsRef.current
    commitCodexChats({ ...current, conversations: current.conversations.map(chat => chat.id === conversationId ? updateCodexConversationMessages(chat, next) : chat) })
  }
  function changeCodexThread(documentId: string, conversationId: string, threadId: string) {
    if (docRef.current?.id !== documentId) return
    const current = codexChatsRef.current
    commitCodexChats({ ...current, conversations: current.conversations.map(chat => chat.id === conversationId ? { ...chat, threadId } : chat) })
  }
  function newCodexConversation() {
    const chat = createCodexConversation()
    const current = codexChatsRef.current
    commitCodexChats({ conversations: [chat, ...current.conversations], activeId: chat.id })
    setCodexContext(null); setCodexDraft('')
  }
  function selectCodexConversation(id: string) {
    const current = codexChatsRef.current
    if (!current.conversations.some(chat => chat.id === id) || current.activeId === id) return
    commitCodexChats({ ...current, activeId: id }); setCodexContext(null); setCodexDraft('')
  }
  const executeCodexTool = useReaderEvent((documentId: string, conversationId: string, tool: string, args: unknown, signal?: AbortSignal) => {
    const dispatch = createPdfToolDispatcher({
      getDocument: () => codexChatsRef.current.activeId === conversationId ? docRef.current : null,
      getCurrentPage: () => currentView.current.page,
      getAnnotations: () => annotationsRef.current,
      onNavigate: target => goToPage(target, false),
      onAddAnnotation: annotation => { changeAnnotations([...annotationsRef.current, annotation]); setSelectedId(null) },
      onNotify: notify,
    })
    return dispatch(tool, args, { documentId, signal })
  })
  async function getCodexPageText(sourcePage: number): Promise<string> {
    const current = docRef.current
    if (!current) return ''
    const content = await (await current.pdf.getPage(sourcePage)).getTextContent()
    return content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').slice(0, 16000)
  }
  async function fitWidth(automatic = false) {
    const current = docRef.current
    if (!current || !viewer.current || (automatic && !fitsWidth.current)) return
    const p = await current.pdf.getPage(page)
    if (current !== docRef.current || !viewer.current || (automatic && !fitsWidth.current)) return
    const width = p.getViewport({ scale: 1, rotation: p.rotate + rotation }).width
    const gutter = 40
    const nextScale = Math.min(5, Math.max(.35, (viewer.current.clientWidth - gutter) / width))
    if (pendingTabScroll.current?.id === current.id) setScale(nextScale)
    else changeZoom(nextScale, true)
  }
  const refitWidth = useReaderEvent(() => fitWidth(true))
  useEffect(() => {
    const root = viewer.current
    if (!root || !doc) return
    let frame = 0
    let previousWidth = 0
    const observer = new ResizeObserver(() => {
      if (root.clientWidth === previousWidth) return
      previousWidth = root.clientWidth
      cancelAnimationFrame(frame)
      if (fitsWidth.current) frame = requestAnimationFrame(() => { void refitWidth() })
    })
    observer.observe(root)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [doc?.id, refitWidth])
  useEffect(() => { if (fitsWidth.current) void refitWidth() }, [rotation, refitWidth])
  useEffect(() => {
    const version = ++searchVersion.current
    const preservePosition = restoreSearchPosition.current
    restoreSearchPosition.current = false
    setSearchPages([]); setSearchIndex(0)
    if (!doc || !query.trim()) { setSearching(false); return }
    setSearching(true)
    const timer = setTimeout(() => {
      void (async () => {
        let texts = textCache.current
        if (!texts) {
          texts = []
          for (let n = 1; n <= doc.pdf.numPages; n++) {
            if (version !== searchVersion.current) return
            const p = await doc.pdf.getPage(n); const content = await p.getTextContent()
            texts.push(content.items.map(item => 'str' in item ? item.str : '').join(' ').toLowerCase())
          }
          textCache.current = texts
        }
        const needle = query.trim().toLowerCase()
        const matches = texts.flatMap((text, index) => {
          let count = 0; let start = 0
          while ((start = text.indexOf(needle, start)) !== -1) { count++; start += needle.length }
          return count ? [{ page: index + 1, count }] : []
        })
        if (version === searchVersion.current) { setSearchPages(matches); setSearching(false); if (matches.length && !preservePosition) goToPage(matches[0].page) }
      })().catch(() => { if (version === searchVersion.current) { setSearching(false); notify('此文档的部分文字无法检索。') } })
    }, 250)
    return () => clearTimeout(timer)
  }, [doc, query, goToPage, notify])
  function nextSearch(direction: number) {
    if (!searchPages.length) return
    const next = (searchIndex + direction + searchPages.length) % searchPages.length
    setSearchIndex(next); goToPage(searchPages[next].page)
  }
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (password || editor || help || recentOpen) return
      const target = event.target as HTMLElement
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable
      if (event.metaKey || event.ctrlKey) {
        const key = event.key.toLowerCase()
        if (key === 'tab' && event.ctrlKey) {
          event.preventDefault()
          const ids = [...tabs.current.keys()]
          const index = ids.indexOf(docRef.current?.id ?? '')
          if (ids.length) selectDocumentTab(ids[(index + (event.shiftKey ? -1 : 1) + ids.length) % ids.length])
        }
        else if (key === 'w' && !event.shiftKey) { event.preventDefault(); void closeCurrentDocument() }
        else if (key === 'o') { event.preventDefault(); void requestOpenFile() }
        else if (key === 'f') { event.preventDefault(); setShowSearch(true) }
        else if (key === 's') { event.preventDefault(); void exportPdf(!!desktop && event.shiftKey) }
        else if (key === 'z' && !typing && !textDraftRef.current) { event.preventDefault(); if (event.shiftKey) redo(); else undo() }
        return
      }
      if (textDraftRef.current) {
        if (event.key === 'Escape') { event.preventDefault(); cancelTextDraft() }
        return
      }
      if (typing) return
      if (event.key === 'Escape') { setOpenToolMenu(null); closeMoreMenu(); setTool('select'); setShowSearch(false); setSelectedId(null) }
      if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); goToPage(page + 1) }
      if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); goToPage(page - 1) }
      const nextTool = TOOLS.find(t => t.shortcut.toLowerCase() === event.key.toLowerCase())
      if (nextTool) void activateTool(nextTool.id)
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedId) { event.preventDefault(); changeAnnotations(annotations.filter(a => a.id !== selectedId)); setSelectedId(null) }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  })
  const scrollFrame = useRef(0)
  useEffect(() => () => cancelAnimationFrame(scrollFrame.current), [])
  function handleScroll() {
    if (scrollFrame.current) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0
      const root = viewer.current; if (!root) return
      const pages = root.querySelectorAll<HTMLElement>('.pdf-page')
      // Find the first page intersecting the viewport without scanning a long paper from page one.
      let low = 0; let high = pages.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (pages[middle].offsetTop + pages[middle].offsetHeight <= root.scrollTop) low = middle + 1
        else high = middle
      }
      let currentPage = 0; let largestVisibleHeight = 0
      for (let index = low; index < pages.length; index++) {
        const el = pages[index]
        const top = el.offsetTop
        if (top >= root.scrollTop + root.clientHeight) break
        const visibleHeight = Math.min(top + el.offsetHeight, root.scrollTop + root.clientHeight) - Math.max(top, root.scrollTop)
        if (visibleHeight > largestVisibleHeight) { largestVisibleHeight = visibleHeight; currentPage = Number(el.dataset.pageNumber) }
      }
      if (currentPage) setPage(current => current === currentPage ? current : currentPage)
    })
  }
  const annotationsByPage = useMemo(() => {
    const groups = new Map<number, Annotation[]>()
    for (const annotation of annotations) {
      const group = groups.get(annotation.page)
      if (group) group.push(annotation)
      else groups.set(annotation.page, [annotation])
    }
    return groups
  }, [annotations])
  const addPageAnnotation = useReaderEvent(addAnnotation)
  const updatePageAnnotation = useReaderEvent(updateAnnotation)
  const changePageText = useReaderEvent(setActiveTextDraft)
  const commitPageText = useReaderEvent(() => { commitTextDraft() })
  const cancelPageText = useReaderEvent(cancelTextDraft)
  const askFromPage = useReaderEvent(askCodex)
  const selectPageAnnotation = useReaderEvent((id: string | null) => {
    setSelectedId(id)
    if (id) { const annotation = annotationsRef.current.find(item => item.id === id); if (annotation?.kind === 'note' && !annotation.text.trim()) openEditor(annotation) }
  })
  function commitPageNumber() {
    if (cancelPageNumber.current) { cancelPageNumber.current = false; setPageInput(String(page)); return }
    const next = Number(pageInput)
    if (Number.isFinite(next) && next >= 1 && next !== page) goToPage(next)
    else setPageInput(String(page))
  }
  const visibleAnnotations = annotations.filter(a => filter === 'all' || a.kind === filter).sort((a, b) => a.page - b.page || a.createdAt - b.createdAt)
  const annotationPages = [...new Set(visibleAnnotations.map(a => a.page))]
  const historyDocuments = recents.filter(recent => recent.name.toLocaleLowerCase().includes(historyQuery.trim().toLocaleLowerCase()))
  const activeTextStyle = textDraft?.textStyle ?? textStyle
  const filteredFonts = fonts.filter(font => matchesFontSearch(font, fontSearch))
  const visibleFonts = filteredFonts.some(font => font.id === activeTextStyle.fontId) ? filteredFonts : [...fonts.filter(font => font.id === activeTextStyle.fontId), ...filteredFonts]
  const saveText = saveStatus === 'saving' ? '正在保存' : saveStatus === 'failed' ? '本机保存不可用，请导出' : '已保存到本机'
  function closeMoreMenu() { moreMenu.current?.removeAttribute('open') }

  function closeDocumentTab(id: string) {
    return enqueueDocumentAction(async () => {
      const closing = tabs.current.get(id)
      if (!closing) return
      const active = docRef.current?.id === id
      if (active) { await saveCompletion.current; captureCurrentTab(true) }
      try { await saveSession(tabs.current.get(id)!.session) }
      catch { notify('阅读记录暂时无法保存，请先导出 PDF 后再关闭。'); return }
      const ids = [...tabs.current.keys()]
      const index = ids.indexOf(id)
      tabs.current.delete(id)
      if (active) {
        docRef.current = null; sessionRef.current = null
        const nextId = ids[index + 1] ?? ids[index - 1]
        if (nextId) await activateDocumentTab(nextId)
        else {
          cancelWheelZoom(); readingAnchor.current = null
          setDoc(null); annotationsRef.current = []; setAnnotations([]); setBookmarks([]); setUndoStack([]); setRedoStack([])
          setSelectedId(null); setEditor(null); setOutline([]); setCodexOpenState(false); setRightPanelState(false); setCodexContext(null); setCodexDraft(''); setQuery(''); setSearchPages([]); setOpenToolMenu(null)
        }
      }
      persistOpenTabs()
      void closing.document.pdf.loadingTask.destroy()
    })
  }
  function closeCurrentDocument() { const id = docRef.current?.id; return id ? closeDocumentTab(id) : Promise.resolve() }
  function renderToolButton(id: Tool) {
    const item = TOOLS.find(value => value.id === id)!
    return <button className={`tool-button${tool === id ? ' active' : ''}`} data-tooltip={item.label} data-shortcut={item.shortcut} aria-keyshortcuts={item.shortcut} aria-label={item.label} aria-pressed={tool === id} disabled={!doc || fontBusy} onMouseDown={event => { if (['highlight', 'underline', 'strikeout'].includes(id)) event.preventDefault() }} onClick={() => void activateTool(id)}><item.icon size={22} strokeWidth={1.2} /></button>
  }
  const colorPalette = <div className="color-palette" aria-label="标注颜色">{COLORS.map((value, index) => <button key={value} style={{ '--swatch': value } as React.CSSProperties} className={`color-swatch${color === value ? ' selected' : ''}`} aria-label={['黄色', '绿色', '紫色', '粉色', '蓝色'][index]} aria-pressed={color === value} data-tooltip={['黄色', '绿色', '紫色', '粉色', '蓝色'][index]} onMouseDown={event => event.preventDefault()} onClick={() => setColor(value)}>{color === value && <Check size={11} />}</button>)}</div>

  return <div className="app-shell" data-theme={theme} data-desktop={desktop?.platform} data-window-active={windowActive} onDragOver={e => { e.preventDefault(); if (e.dataTransfer.types.includes('Files')) setDragging(true) }} onDrop={e => { e.preventDefault(); setDragging(false); void openFiles(Array.from(e.dataTransfer.files)) }}>
    <input ref={fileInput} type="file" accept="application/pdf,.pdf" aria-label="选择 PDF 文件" hidden multiple onChange={e => { void openFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} />
    <input ref={fontInput} type="file" accept=".ttf,.otf,.ttc,.otc,.woff,.woff2,.dfont" aria-label="导入字体文件" hidden multiple onChange={e => { void importFontFiles(e.target.files); e.target.value = '' }} />
    <main className="workspace">
      <DocumentTabs documents={openTabs.map(item => ({ id: item.id, name: item.name, saveStatus: item.id === doc?.id ? saveStatus : 'saved' }))} activeId={doc?.id ?? null} onSelect={selectDocumentTab} onClose={id => void closeDocumentTab(id)} onOpen={() => void requestOpenFile()} onHistory={() => void showHistory()}>
        <div className="tab-actions"><IconButton icon={ReaderIcons.History} label="最近阅读" aria-haspopup="dialog" onClick={() => void showHistory()} /><IconButton icon={CircleHelp} label="使用帮助" onClick={() => setHelp(true)} />
          <details className="more-menu" ref={moreMenu}>
            <summary aria-label="更多" data-tooltip="文件选项" aria-haspopup="menu"><ReaderIcons.More size={18} /></summary>
            <div className="more-menu-content" role="menu" aria-label="更多操作">
              <div className="menu-document" title={doc?.name}>{doc?.name ?? 'PDF 阅读器'}</div>
              <button role="menuitem" aria-label="打开文件" onClick={() => { closeMoreMenu(); void requestOpenFile() }}><ReaderIcons.Open size={16} />打开 PDF…<kbd>⌘ / Ctrl O</kbd></button>
              <button role="menuitem" aria-label={desktop ? '保存 PDF' : '导出 PDF'} disabled={!doc || exporting || loading} onClick={() => { closeMoreMenu(); void exportPdf() }}>{exporting ? <LoaderCircle size={16} className="spin" /> : <ReaderIcons.Save size={16} />}{desktop ? '保存' : '导出 PDF…'}<kbd>⌘ / Ctrl S</kbd></button>
              {desktop && <button role="menuitem" aria-label="另存为 PDF" disabled={!doc || exporting || loading} onClick={() => { closeMoreMenu(); void exportPdf(true) }}><ReaderIcons.Save size={16} />另存为…<kbd>⌘ / Ctrl ⇧ S</kbd></button>}
              <div className="menu-divider" />
              <button role="menuitem" aria-label="撤销" disabled={!undoStack.length} onClick={() => { closeMoreMenu(); undo() }}><ReaderIcons.Undo size={16} />撤销<kbd>⌘ / Ctrl Z</kbd></button>
              <button role="menuitem" aria-label="重做" disabled={!redoStack.length} onClick={() => { closeMoreMenu(); redo() }}><ReaderIcons.Redo size={16} />重做<kbd>⌘ / Ctrl ⇧ Z</kbd></button>
              <div className="menu-divider" />
              <button role="menuitem" onClick={() => { closeMoreMenu(); setShowSearch(value => !value) }}><ReaderIcons.Search size={16} />搜索<kbd>⌘ / Ctrl F</kbd></button>
              <button role="menuitem" disabled={!doc} onClick={() => { closeMoreMenu(); toggleBookmark() }}><ReaderIcons.Bookmark size={16} />书签<span>{bookmarks.includes(page) ? '移除本页书签' : '添加本页书签'}</span></button>
              <button role="menuitem" onClick={() => void showHistory()}><ReaderIcons.History size={16} />最近阅读</button>
              <button role="menuitem" onClick={() => { closeMoreMenu(); setHelp(true) }}><CircleHelp size={16} />使用帮助</button>
              <div className={`menu-save-state ${saveStatus}`}>{saveStatus === 'saving' ? <LoaderCircle size={12} className="spin" /> : <Check size={12} />}{saveText}</div>
            </div>
          </details>
        </div>
      </DocumentTabs>
      <div className={`reader-layout ${!leftPanel ? 'hide-left' : ''} ${!rightPanel ? 'hide-right' : ''}`}>
        <nav className="navigation-rail" aria-label="阅读导航">
          <IconButton icon={ReaderIcons.Grid} label="切换页面面板" onClick={() => setLeftPanel(value => !value)} />
          <span className="rail-divider" />
          <IconButton icon={ReaderIcons.Search} label="查找文档" active={showSearch} onClick={() => setShowSearch(value => !value)} />
          <IconButton icon={ReaderIcons.Pages} label="页面缩略图" active={leftPanel && leftTab === 'pages'} onClick={() => { setLeftTab('pages'); setLeftPanel(value => leftTab === 'pages' ? !value : true) }} />
          <IconButton icon={ReaderIcons.Bookmark} label="页面书签" active={leftPanel && leftTab === 'bookmarks'} onClick={() => { setLeftTab('bookmarks'); setLeftPanel(value => leftTab === 'bookmarks' ? !value : true) }} />
          <IconButton icon={ReaderIcons.Comments} label="查看标注" active={rightPanel && !codexOpen} onClick={() => { setCodexOpen(false); setRightPanel(value => codexOpen ? true : !value) }} />
          <IconButton icon={ReaderIcons.Outline} label="文档目录" active={leftPanel && leftTab === 'outline'} onClick={() => { setLeftTab('outline'); setLeftPanel(value => leftTab === 'outline' ? !value : true) }} />
          <div className="rail-bottom"><IconButton icon={ReaderIcons.Theme} label={theme === 'dark' ? '切换浅色外观' : '切换深色外观'} onClick={() => setTheme(value => value === 'dark' ? 'light' : 'dark')} /></div>
        </nav>
        {leftPanel && <aside className="pages-panel"><div className="pages-heading"><h2>{leftTab === 'pages' ? '缩略图' : leftTab === 'outline' ? '目录' : '书签'}</h2><IconButton icon={ReaderIcons.Close} label="关闭页面面板" onClick={() => setLeftPanel(false)} /></div><div className="pages-content">{doc && leftTab === 'pages' && <><div className="thumbnails">{Array.from({ length: doc.pdf.numPages }, (_, n) => <Thumbnail key={`${doc.id}-${n}`} pdf={doc.pdf} pageNumber={n + 1} active={page === n + 1} onNavigate={goToPage} />)}</div></>}{leftTab === 'outline' && (outline.length ? <div className="outline-list">{outline.map((entry, i) => <button key={i} style={{ paddingLeft: 14 + entry.level * 12 }} onClick={() => goToPage(entry.page)}><List size={13} /><span>{entry.title}</span><small>{entry.page}</small></button>)}</div> : <div className="panel-empty"><List size={26} strokeWidth={1.2} /><p>这份文档没有目录</p><span>可以通过页面缩略图导航</span></div>)}{leftTab === 'bookmarks' && (bookmarks.length ? <div className="bookmark-list">{bookmarks.map(p => <div key={p}><button onClick={() => goToPage(p)}><Bookmark size={14} />第 {p} 页</button><IconButton icon={X} label={`删除第 ${p} 页书签`} onClick={() => setBookmarks(bookmarks.filter(b => b !== p))} /></div>)}</div> : <div className="panel-empty"><Bookmark size={26} strokeWidth={1.2} /><p>收藏值得重读的页面</p><span>在“更多”菜单中添加书签</span></div>)}</div></aside>}
        <section className={`reader-area${showSearch ? ' has-search' : ''}${tool === 'text' || textDraft ? ' has-text-format' : ''}`} onPointerMove={wakeControls} onFocusCapture={wakeControls} onKeyDownCapture={wakeControls}>
          <div className="toolbar" aria-label="阅读与标注工具">
            <div className="annotation-tools tool-list" role="toolbar" aria-label="注释与阅读助手">
              <IconButton icon={ReaderIcons.Sparkles} label="Codex AI" className="codex-entry" active={rightPanel && codexOpen} aria-expanded={rightPanel && codexOpen} disabled={!doc} onClick={() => { if (rightPanel && codexOpen) setRightPanel(false); else { setCodexOpen(true); setRightPanel(true) } }} />
              <span className="small-divider" />
              <div className="split-tool tool-dropdown">
                {renderToolButton(tool === 'hand' ? 'hand' : 'select')}
                <button className="tool-menu-trigger" aria-label="选择工具选项" aria-haspopup="menu" aria-expanded={openToolMenu === 'select'} onMouseDown={event => event.preventDefault()} onClick={() => setOpenToolMenu(value => value === 'select' ? null : 'select')}><ReaderIcons.ChevronDown size={12} /></button>
                {openToolMenu === 'select' && <div className="tool-popover selection-popover" role="menu" aria-label="选择工具">{TOOLS.filter(item => ['select', 'hand'].includes(item.id)).map(item => <button key={item.id} role="menuitemradio" aria-checked={tool === item.id} className="dropdown-option" onClick={() => void activateTool(item.id)}><item.icon size={20} /><span>{item.label}</span><kbd>{item.shortcut}</kbd></button>)}</div>}
              </div>
              <span className="small-divider" />
              <div className="split-tool tool-dropdown">
                {renderToolButton(['highlight', 'underline', 'strikeout'].includes(tool) ? tool : lastMarkup)}
                <button className="tool-menu-trigger" aria-label="高亮与划线选项" aria-haspopup="menu" aria-expanded={openToolMenu === 'markup'} onMouseDown={event => event.preventDefault()} onClick={() => setOpenToolMenu(value => value === 'markup' ? null : 'markup')}><ReaderIcons.ChevronDown size={12} /></button>
                {openToolMenu === 'markup' && <div className="tool-popover markup-popover" role="menu" aria-label="高亮与划线">{TOOLS.filter(item => ['highlight', 'underline', 'strikeout'].includes(item.id)).map(item => <button key={item.id} role="menuitemradio" aria-checked={tool === item.id} className="dropdown-option" onMouseDown={event => event.preventDefault()} onClick={() => void activateTool(item.id)}><item.icon size={20} /><span>{item.label}</span><kbd>{item.shortcut}</kbd></button>)}<div className="popover-label">标注颜色</div>{colorPalette}</div>}
              </div>
              <div className="split-tool">{renderToolButton('text')}<button className="tool-menu-trigger" aria-label="文字格式" data-tooltip="文字格式" disabled={!doc || fontBusy} onClick={() => void activateTool('text')}><ReaderIcons.ChevronDown size={12} /></button></div>
              {renderToolButton('note')}
              {renderToolButton('draw')}
              <div className="reference-tools" aria-label="其他注释工具">{[{ icon: ReaderIcons.Shapes, name: '形状' }, { icon: ReaderIcons.Measure, name: '测量' }, { icon: ReaderIcons.Attachment, name: '附件' }, { icon: ReaderIcons.Sticker, name: '贴纸' }, { icon: ReaderIcons.Stamp, name: '图章' }, { icon: ReaderIcons.Signature, name: '签名' }].map(({ icon: Icon, name }) => <button className="tool-button" key={name} aria-label={name} disabled><Icon size={22} /></button>)}</div>
            </div>
          </div>
      {(tool === 'text' || textDraft) && <div className="text-format-bar" aria-label="文字格式">
        <div className="font-picker"><input aria-label="筛选字体" value={fontSearch} placeholder="搜索中英文字体名…" onChange={e => setFontSearch(e.target.value)} /><select aria-label="字体" value={activeTextStyle.fontId} disabled={fontBusy} onChange={e => void chooseFont(e.target.value)}>{!visibleFonts.length && <option value={activeTextStyle.fontId}>{activeTextStyle.fontName}</option>}{visibleFonts.map(font => <option key={font.id} value={font.id}>{fontLabel(font)}</option>)}</select></div>
        <label className="text-size"><input type="number" min="6" max="144" aria-label="字号" value={activeTextStyle.fontSize} onChange={e => { const value = Number(e.target.value); if (value >= 6 && value <= 144) applyTextStyle({ fontSize: value }) }} /><span>pt</span></label>
        <label className="text-color" title="文字颜色"><input type="color" aria-label="文字颜色" value={textDraft?.color ?? textColor} onChange={e => { setTextColor(e.target.value); if (textDraftRef.current) setActiveTextDraft({ ...textDraftRef.current, color: e.target.value }) }} /></label>
        <span className="small-divider" />
        <IconButton icon={Bold} label="粗体" active={activeTextStyle.bold} disabled={fontBusy} onClick={() => toggleTextFormat('bold')} />
        <IconButton icon={Italic} label="斜体" active={activeTextStyle.italic} disabled={fontBusy} onClick={() => toggleTextFormat('italic')} />
        <IconButton icon={Underline} label="文字下划线" active={activeTextStyle.underline} onClick={() => applyTextStyle({ underline: !activeTextStyle.underline })} />
        <span className="small-divider" />
        {([{ id: 'left', label: '左对齐', icon: AlignLeft }, { id: 'center', label: '居中对齐', icon: AlignCenter }, { id: 'right', label: '右对齐', icon: AlignRight }] as const).map(item => <IconButton key={item.id} icon={item.icon} label={item.label} active={activeTextStyle.align === item.id} onClick={() => applyTextStyle({ align: item.id })} />)}
        <select className="text-line-height" aria-label="文字行距" value={activeTextStyle.lineHeight} onChange={e => applyTextStyle({ lineHeight: Number(e.target.value) })}>{[1.2, 1.4, 1.6, 2].map(height => <option key={height} value={height}>{height} 倍行距</option>)}</select>
        <label className="text-width">宽<input type="number" min="60" max="1000" aria-label="文本框宽度" value={activeTextStyle.width} onChange={e => { const value = Number(e.target.value); if (value >= 60 && value <= 1000) applyTextStyle({ width: value }) }} /></label>
        <div className="font-actions"><button className="text-format-action" title="重新扫描本机字体；静态部署时请求浏览器字体访问权限" disabled={fontBusy} onClick={() => void readBrowserFonts()}>读取本机字体</button><button className="text-format-action" disabled={fontBusy} onClick={() => fontInput.current?.click()}>导入字体</button>{fontBusy && <LoaderCircle className="spin" size={14} />}</div>
        {textDraft ? <div className="text-draft-actions"><button className="button subtle" onClick={cancelTextDraft}>取消</button><button className="button export-button" disabled={fontBusy} onClick={() => commitTextDraft()}><Check size={13} />完成</button></div> : <span className="text-tool-hint">点击页面输入文字</span>}
      </div>}
      <span className="save-state sr-only" aria-live="polite">{saveText}</span>
      {showSearch && <div className="search-bar"><Search size={16} /><input type="search" ref={searchInput} aria-label="搜索文档" placeholder="在文档中搜索…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') nextSearch(e.shiftKey ? -1 : 1) }} /><span className="search-count">{searching ? '搜索中…' : query ? searchPages.length ? `${searchPages.reduce((sum, p) => sum + p.count, 0)} 处匹配 · ${searchIndex + 1}/${searchPages.length} 页` : '未找到匹配文字' : '搜索可选择的文字'}</span><IconButton icon={ChevronLeft} label="上一个搜索结果" disabled={!searchPages.length} onClick={() => nextSearch(-1)} /><IconButton icon={ChevronRight} label="下一个搜索结果" disabled={!searchPages.length} onClick={() => nextSearch(1)} /><IconButton icon={X} label="关闭搜索" onClick={() => { setShowSearch(false); setQuery('') }} /></div>}
      <div className="document-scroll" ref={viewer} onScroll={handleScroll}>{doc ? <div className="document-pages" key={doc.id}>{Array.from({ length: doc.pdf.numPages }, (_, n) => <MemoPdfPage key={`${doc.id}-${n}`} pdf={doc.pdf} pageNumber={n + 1} scale={scale} rotation={rotation} tool={tool} color={color} annotations={annotationsByPage.get(n + 1) ?? EMPTY_ANNOTATIONS} selectedId={annotationsByPage.get(n + 1)?.some(a => a.id === selectedId) ? selectedId : null} searchQuery={query.trim()} textStyle={textStyle} textDraft={textDraft?.page === n + 1 ? textDraft : null} onTextDraftChange={changePageText} onTextCommit={commitPageText} onTextCancel={cancelPageText} onAskCodex={askFromPage} onNotify={notify} onAdd={addPageAnnotation} onUpdate={updatePageAnnotation} onSelect={selectPageAnnotation} />)}</div> : !loading && <div className="welcome-empty"><BookOpen size={50} strokeWidth={1} /><h2>打开 PDF</h2><p>拖入文件，或点击下方按钮。</p><button className="button export-button" onClick={() => void requestOpenFile()}><FolderOpen size={16} />打开 PDF 文件</button></div>}</div><div className={`floating-controls${controlsVisible ? '' : ' is-idle'}`} onPointerEnter={wakeControls}><IconButton icon={ChevronLeft} label="上一页" disabled={!doc || page <= 1} onClick={() => goToPage(page - 1)} /><input aria-label="当前页码" value={pageInput} onChange={e => setPageInput(e.target.value)} onFocus={event => event.currentTarget.select()} onBlur={commitPageNumber} onKeyDown={event => { if (event.key === 'Enter') { event.currentTarget.blur() } else if (event.key === 'Escape') { event.preventDefault(); cancelPageNumber.current = true; event.currentTarget.blur() } }} /><span className="page-total">/ {doc?.pdf.numPages ?? 0}</span><IconButton icon={ChevronRight} label="下一页" disabled={!doc || page >= doc.pdf.numPages} onClick={() => goToPage(page + 1)} /><span className="small-divider" /><IconButton icon={Minus} label="缩小" disabled={scale <= .35} onClick={() => changeZoom(+(scale - .1).toFixed(2))} /><select aria-label="缩放比例" value={Number(scale.toFixed(3))} onChange={e => changeZoom(Number(e.target.value))}>{![.5, .75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5].includes(Number(scale.toFixed(3))) && <option value={Number(scale.toFixed(3))}>{Math.round(scale * 100)}%</option>}{[.5, .75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5].map(s => <option value={s} key={s}>{s * 100}%</option>)}</select><IconButton icon={Plus} label="放大" disabled={scale >= 5} onClick={() => changeZoom(+(scale + .1).toFixed(2))} /><span className="small-divider" /><IconButton icon={Maximize2} label="适合宽度" onClick={() => void fitWidth()} disabled={!doc} /><IconButton icon={RotateCw} label="旋转页面" disabled={!doc} onClick={rotatePage} /></div></section>
        {rightPanel && (codexOpen && doc ? <CodexPanel key={`${doc.id}:${codexChats.activeId}`} documentId={doc.id} conversationId={codexChats.activeId} conversations={codexChats.conversations} onNewConversation={newCodexConversation} onSelectConversation={selectCodexConversation} initialQuestion={codexDraft} registerBeforeLeave={registerCodexLeave} threadId={codexThreadId} onThreadChange={id => changeCodexThread(doc.id, codexChats.activeId, id)} onToolCall={(tool, args, signal) => executeCodexTool(doc.id, codexChats.activeId, tool, args, signal)} documentName={doc.name} currentPage={page} context={codexContext} onContextConsumed={consumeCodexContext} messages={codexMessages} onMessagesChange={next => changeCodexMessages(doc.id, codexChats.activeId, next)} getPageText={getCodexPageText} onNavigate={goToPage} onResize={resizeCodexPanel} onBack={() => setCodexOpen(false)} onClose={() => setRightPanel(false)} /> : <aside className="annotations-panel"><div className="annotation-heading"><h2>标注 <span>{annotations.length}</span></h2><IconButton icon={X} label="关闭标注面板" onClick={() => setRightPanel(false)} /></div><div className="annotation-filters">{[{ id: 'all', label: '全部' }, { id: 'highlight', label: '高亮' }, { id: 'note', label: '便签' }].map(f => <button key={f.id} className={filter === f.id ? 'active' : ''} onClick={() => setFilter(f.id)}>{f.label}</button>)}</div><div className="annotations-content">{annotationPages.map(p => <div className="annotation-group" key={p}><button className="annotation-page" onClick={() => goToPage(p)}>第 {String(p).padStart(2, '0')} 页<ArrowUpRight size={12} /></button>{visibleAnnotations.filter(a => a.page === p).map(a => <article key={a.id} className={`annotation-card ${selectedId === a.id ? 'selected' : ''}`} tabIndex={0} onClick={() => { goToPage(a.page); openEditor(a) }} onKeyDown={e => { if (e.key === 'Enter') { goToPage(a.page); openEditor(a) } }}><div className="annotation-card-top"><span className="annotation-kind"><span style={{ background: a.color }} />{ANNOTATION_LABELS[a.kind]}</span><IconButton icon={Trash2} label="删除标注" onClick={e => { e.stopPropagation(); changeAnnotations(annotations.filter(item => item.id !== a.id)); if (selectedId === a.id) setSelectedId(null) }} /></div>{a.text && <blockquote style={{ borderLeftColor: a.color }}>{a.text}</blockquote>}{a.comment && <p className="annotation-comment">{a.comment}</p>}{!a.text && !a.comment && <p className="annotation-placeholder">{a.kind === 'draw' ? '手绘标注' : '点击添加你的想法…'}</p>}<div className="annotation-card-bottom">{a.text.trim() && <button className="annotation-ask" aria-label="向 Codex 提问这条标注" onClick={e => { e.stopPropagation(); askCodex(a.text, a.page) }} onKeyDown={e => e.stopPropagation()}><MessageSquare size={10} />问 Codex</button>}<span>{new Date(a.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span></div></article>)}</div>)}{!visibleAnnotations.length && <div className="panel-empty annotation-empty"><MessageSquare size={30} strokeWidth={1.1} /><h3>暂无标注</h3><p>选中文字添加高亮或划线，<br />也可以使用便签和画笔。</p></div>}</div></aside>)}
      </div>
    </main>
    <ControlTooltip />
    {loading && <div className="loading-overlay"><LoaderCircle className="spin" size={26} /><p>正在打开 PDF…</p></div>}
    {toast && <div className="toast" role="status"><Check size={16} /><span>{toast}</span><button aria-label="关闭提示" onClick={() => setToast('')}><X size={14} /></button></div>}
    {dragging && <div className="drop-overlay" onDragLeave={() => setDragging(false)}><div><FilePlus2 size={42} strokeWidth={1.2} /><h2>松开以打开 PDF</h2></div></div>}
    {editor && <Modal title={editor.kind === 'note' ? '添加便签' : '编辑标注'} onClose={closeEditor}><div className="editor-type"><span style={{ background: editor.color }} />{ANNOTATION_LABELS[editor.kind]}<span className="editor-page">第 {editor.page} 页</span></div>{editor.text && <blockquote className="editor-quote">{editor.text}</blockquote>}<label className="field-label" htmlFor="annotation-comment">{editor.kind === 'note' ? '便签内容' : '添加笔记'}</label><textarea id="annotation-comment" aria-label="标注内容" autoFocus placeholder="输入标注内容…" value={editText} onChange={e => setEditText(e.target.value)} onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') saveEditor() }} /><div className="modal-actions"><span>⌘ / Ctrl + Enter 保存</span><button className="button subtle" onClick={closeEditor}>取消</button><button className="button export-button" onClick={saveEditor}>保存</button></div></Modal>}
    {password && <Modal title={password.wrong ? '密码不正确，请重试' : '这份文档需要密码'} onClose={password.cancel}><p className="modal-description">输入文档的打开密码，解锁后即可阅读。</p><form onSubmit={e => { e.preventDefault(); password.submit(passwordInput) }}><input className="password-input" type="password" autoFocus aria-label="PDF 密码" value={passwordInput} onChange={e => setPasswordInput(e.target.value)} /><div className="modal-actions"><button type="button" className="button subtle" onClick={password.cancel}>取消</button><button className="button export-button" type="submit">解锁文档</button></div></form></Modal>}
    {help && <Modal title="ExPDF · 使用帮助" onClose={() => setHelp(false)} className="help-modal"><div className="help-brand"><img src="/favicon.png" width="44" height="44" alt="" /><div><strong>让你的 Codex 订阅，直接参与阅读。</strong><span>直接接入本机 Codex 的 PDF 阅读器</span></div></div><p className="modal-description">复用本机 Codex 登录与现有订阅，无需在 ExPDF 中填写 API Key。{desktop ? '阅读记录与标注自动保存在本机。' : '文档与标注保存在当前浏览器中。'}</p><div className="help-grid">{TOOLS.map(t => <div key={t.id}><t.icon size={16} /><span>{t.label}</span><kbd>{t.shortcut}</kbd></div>)}</div><div className="help-note"><p><strong>添加文字</strong> 选择 T 工具，在页面点击后输入。上方可设置字体、字号、颜色和段落格式；完成后可拖动，双击文字可再次编辑。本地字体不会上传到云端。</p><p><strong>接入 Codex</strong> 在本机安装 Codex CLI，并使用 ChatGPT 账户登录，即可使用订阅内可用的模型与额度。选中文字后点击“问 Codex”，也可从已有高亮或划线发起。可直接提问，也可让助手读取整篇论文、检索资料、计算或生成文件。在输入框底部选择模型与思考深度，顶部插头查看工具与连接；需要权限时会显示确认卡片。桌面控制已关闭，问答记录随文档保存在本机。</p><p><strong>自动保存</strong> {desktop ? '阅读记录与标注保存在本机，重新打开应用后会恢复。使用保存或另存为，将标注写入 PDF 文件。' : '文档与标注保存在当前浏览器，刷新后会恢复。清理网站数据会移除本地记录，请及时导出重要标注。'}</p><p><strong>{desktop ? '保存 PDF' : '导出 PDF'}</strong> 将高亮、划线、画笔与中文便签作为原生标注写入 PDF，方便在其他阅读器里打开。</p><p><strong>扫描文档</strong> 可阅读、绘制与添加便签；文字高亮与搜索需要 PDF 本身包含文字层。</p></div><div className="modal-actions"><span>{desktop ? '打开 ⌘O · 保存 ⌘S · 另存为 ⌘⇧S' : '打开 ⌘O · 搜索 ⌘F · 导出 ⌘S'}</span><button className="button export-button" onClick={() => setHelp(false)}>开始阅读</button></div></Modal>}
    {recentOpen && <Modal title="最近阅读" onClose={() => setRecentOpen(false)} className="recent-popover">
      <label className="history-search"><Search size={15} /><input type="search" aria-label="搜索历史 PDF" placeholder="搜索历史 PDF…" value={historyQuery} onChange={e => setHistoryQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); setRecentOpen(false) } }} autoFocus /></label>
      <div className="history-summary">{historyQuery.trim() ? `${historyDocuments.length} 个匹配文档` : `${recents.length} 个文档`}</div>
      <div className="recent-list">{historyDocuments.map(recent => <button key={recent.id} className={recent.id === doc?.id ? 'current' : ''} aria-label={`打开历史 PDF：${recent.name}`} title={recent.name} onClick={() => void openRecentDocument(recent.id)}>
        <div className="recent-file-icon"><FileText size={20} strokeWidth={1.4} /></div>
        <div><strong>{recent.name}</strong><span>读至第 {recent.lastPage} 页 · {new Date(recent.updatedAt).toLocaleDateString('zh-CN')}</span></div>
        {recent.id === doc?.id ? <small className="current-document">当前文件</small> : <ChevronRight size={15} />}
      </button>)}</div>
      {!historyDocuments.length && <div className="history-empty">{historyQuery.trim() ? '没有找到匹配的 PDF' : '打开过的 PDF 会自动出现在这里'}</div>}
      <button className="button subtle recent-open-file" onClick={() => void requestOpenFile()}><Plus size={16} />打开其他 PDF</button>
    </Modal>}

  </div>
}
