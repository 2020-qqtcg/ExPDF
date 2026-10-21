import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUp, Check, Copy, FolderOpen, LoaderCircle, MessageSquare, MessagesSquare, Plug, RefreshCw, Square, SquarePen, X } from 'lucide-react'
import CodexMarkdown from './CodexMarkdown'
import CodexSelect from './CodexSelect'
import useCodexPanelResize from './useCodexPanelResize'
import { CodexActivityList, CodexAgentRequest } from './CodexAgentWork'
import { respondToAgent, runCodexAgent } from '../lib/codex-agent'
import type { AgentActivity, AgentRequest, AgentStatus } from '../lib/codex-agent'
import { getDesktopBridge } from '../lib/desktop'
import type { CodexContext, CodexConversation, CodexMessage } from '../types'
import { normalizeCodexPreferences, parseCodexModelCatalog, readCodexPreferences, resolveCodexSelection, saveCodexPreferences } from '../lib/codex-settings'
import type { CodexModelCatalog } from '../lib/codex-settings'
import './codex-panel.css'

interface Props {
  documentId: string
  documentName: string
  conversationId: string
  conversations: CodexConversation[]
  onNewConversation: () => void
  onSelectConversation: (id: string) => void
  initialQuestion?: string
  registerBeforeLeave?: (handler: () => string) => () => void
  threadId?: string
  onThreadChange: (threadId: string) => void
  onToolCall: (tool: string, args: unknown, signal?: AbortSignal) => Promise<unknown>
  currentPage: number
  context: CodexContext | null
  onContextConsumed: (version: number) => void
  messages: CodexMessage[]
  onMessagesChange: (messages: CodexMessage[]) => void
  getPageText: (page: number) => Promise<string>
  onNavigate: (page: number) => void
  onResize: () => void
  onBack: () => void
  onClose: () => void
}
interface Status { available: boolean; loggedIn: boolean; message?: string; agent?: boolean }

function historyForRequest(messages: CodexMessage[]) {
  const history = messages.slice(-12).map(message => ({
    role: message.role,
    content: (message.role === 'user' && message.quote ? `第 ${message.page} 页摘录：\n${message.quote.slice(0, 2000)}\n\n问题：${message.content}` : message.content).slice(0, 4000),
  }))
  while (history.reduce((length, message) => length + message.content.length, 0) > 16000) history.shift()
  return history
}

export default function CodexPanel({ documentId, documentName, conversationId, conversations, onNewConversation, onSelectConversation, initialQuestion = '', registerBeforeLeave, threadId, onThreadChange, onToolCall, currentPage, context, onContextConsumed, messages, onMessagesChange, getPageText, onNavigate, onResize, onBack, onClose }: Props) {
  const panelId = useId()
  const { panel, width, resizing, separatorProps } = useCodexPanelResize(onResize)
  const [status, setStatus] = useState<Status | null>(null)
  const [statusVersion, setStatusVersion] = useState(0)
  const [question, setQuestion] = useState(initialQuestion)
  const questionRef = useRef(question)
  questionRef.current = question
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState('')
  const [agentAnswer, setAgentAnswer] = useState('')
  const [activities, setActivities] = useState<AgentActivity[]>([])
  const [agentRequests, setAgentRequests] = useState<AgentRequest[]>([])
  const [workspace, setWorkspace] = useState('')
  const [conversationsOpen, setConversationsOpen] = useState(false)
  const [connectionsOpen, setConnectionsOpen] = useState(false)
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  const [connectionsError, setConnectionsError] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<CodexModelCatalog | null>(null)
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [preferences, setPreferences] = useState(() => readCodexPreferences())
  const historyRoot = useRef<HTMLDivElement>(null)
  const historyButton = useRef<HTMLButtonElement>(null)
  const activeTurn = useRef<{ previous: CodexMessage[]; user: CodexMessage; answer: string; activities: AgentActivity[]; recorded: boolean } | null>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const end = useRef<HTMLDivElement>(null)
  const request = useRef<AbortController | null>(null)
  const runId = useRef<string | null>(null)
  const followOutput = useRef(true)
  const previousContext = useRef(context?.version)

  useEffect(() => {
    let disposed = false
    setStatus(null)
    void fetch(`/api/codex/status${statusVersion ? '?refresh=1' : ''}`).then(async response => {
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error()
      const value = await response.json() as Status
      if (!disposed) setStatus(value)
    }).catch(() => { if (!disposed) setStatus({ available: false, loggedIn: false, message: 'Codex 连接暂不可用，请通过本机服务运行阅读器。' }) })
    return () => { disposed = true }
  }, [statusVersion])
  useEffect(() => {
    let disposed = false
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 12_000)
    setCatalog(null); setCatalogState('loading')
    void fetch(`/api/codex/models${statusVersion ? '?refresh=1' : ''}`, { signal: controller.signal }).then(async response => {
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error()
      const value = parseCodexModelCatalog(await response.json())
      if (!value) throw new Error()
      if (!disposed) {
        setPreferences(current => normalizeCodexPreferences(value, current))
        setCatalog(value); setCatalogState('ready')
      }
    }).catch(() => { if (!disposed) { setCatalog(null); setCatalogState('unavailable') } }).finally(() => clearTimeout(timeout))
    return () => { disposed = true; clearTimeout(timeout); controller.abort() }
  }, [statusVersion])
  useEffect(() => { if (catalog) saveCodexPreferences(normalizeCodexPreferences(catalog, preferences)) }, [catalog, preferences])
  function stopRequest() {
    const id = runId.current
    if (id) void fetch('/api/codex/agent/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: id }) }).catch(() => {})
    request.current?.abort()
  }
  useEffect(() => () => { stopRequest(); request.current = null; activeTurn.current = null }, [])
  useEffect(() => {
    if (!conversationsOpen) return
    const outside = (event: Event) => { if (!historyRoot.current?.contains(event.target as Node)) setConversationsOpen(false) }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', outside)
    const current = historyRoot.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]')
    current?.focus({ preventScroll: true })
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('focusin', outside) }
  }, [conversationsOpen])
  function leaveConversation(action: () => void) {
    const turn = activeTurn.current
    if (request.current && turn && !turn.recorded) {
      onMessagesChange([...turn.previous, turn.user, { id: crypto.randomUUID(), role: 'assistant', content: turn.answer || '本轮任务已停止。', activities: turn.activities.map(item => ['running', 'inProgress'].includes(item.status) ? { ...item, status: 'interrupted' } : item) }])
      turn.recorded = true
    }
    stopRequest(); request.current = null; activeTurn.current = null
    action()
  }
  useEffect(() => registerBeforeLeave?.(() => {
    leaveConversation(() => {})
    return questionRef.current
  }), [registerBeforeLeave])
  useEffect(() => {
    // Consuming a sent quote clears the composer without interrupting its request.
    if (context && previousContext.current !== context.version) {
      const active = request.current
      stopRequest(); request.current = null; activeTurn.current = null; active?.abort()
      setQuestion(''); setError(''); setBusy(false); setPending(''); setAgentAnswer(''); setActivities([]); setAgentRequests([])
      previousContext.current = context?.version
    }
    input.current?.focus()
  }, [context?.version])
  useEffect(() => { if (followOutput.current) end.current?.scrollIntoView({ block: 'nearest' }) }, [messages.length, pending, busy, agentAnswer, activities.length, agentRequests.length])
  useEffect(() => {
    if (!connectionsOpen || !status?.agent) return
    let disposed = false
    const controller = new AbortController()
    setAgentStatus(null); setConnectionsError('')
    void fetch('/api/codex/agent/status', { signal: controller.signal }).then(async response => {
      const value = await response.json() as AgentStatus & { error?: string }
      if (!response.ok) throw new Error(value.error || '无法读取工具连接状态。')
      if (!disposed) setAgentStatus(value)
    }).catch(cause => { if (!disposed) setConnectionsError(cause instanceof Error ? cause.message : '连接失败，请重试。') })
    return () => { disposed = true; controller.abort() }
  }, [connectionsOpen, status?.agent, statusVersion])
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(null), 1800); return () => clearTimeout(timer) }, [copied])
  useLayoutEffect(() => {
    const textarea = input.current
    if (!textarea) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.max(64, Math.min(144, textarea.scrollHeight))}px`
    textarea.style.overflowY = textarea.scrollHeight > 144 ? 'auto' : 'hidden'
  }, [question, width])

  async function ask(value = question) {
    const content = value.trim()
    if (!content || request.current || !status?.available || !status.loggedIn) return
    const controller = new AbortController()
    request.current = controller
    const selected = { page: context?.quote.trim() ? context.page : currentPage, quote: context?.quote ?? '' }
    const settings = catalog ? resolveCodexSelection(catalog, preferences) : null
    const agent = !!status.agent
    const userMessage: CodexMessage = { id: crypto.randomUUID(), role: 'user', content, page: selected.page, ...(selected.quote ? { quote: selected.quote } : {}) }
    activeTurn.current = { previous: messages, user: userMessage, answer: '', activities: [], recorded: false }
    let answer = ''
    let work: AgentActivity[] = []
    let recorded = false
    runId.current = null; followOutput.current = true
    setError(''); setBusy(true); setPending(content); setQuestion(''); setAgentAnswer(''); setActivities([]); setAgentRequests([])
    if (context) onContextConsumed(context.version)
    try {
      const pageText = await getPageText(selected.page).catch(() => '')
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const body = { documentName, page: selected.page, quote: selected.quote.slice(0, 12000), pageText: pageText.slice(0, 16000), question: content, messages: historyForRequest(messages), ...(settings ? { model: settings.model.id, ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}) } : {}) }
      if (agent) {
        await runCodexAgent({ ...body, documentId, conversationId, ...(threadId ? { threadId } : {}) }, controller.signal, async event => {
          if (controller.signal.aborted || request.current !== controller) return
          if (event.type === 'thread') { runId.current = event.runId; setWorkspace(event.workspace); onThreadChange(event.threadId) }
          else if (event.type === 'delta') { answer += event.text; if (activeTurn.current) activeTurn.current.answer = answer; setAgentAnswer(answer) }
          else if (event.type === 'activity') {
            const item = { ...event.item, detail: event.item.detail?.slice(0, 8000) }
            work = work.some(current => current.id === item.id) ? work.map(current => current.id === item.id ? item : current) : [...work, item].slice(-100)
            if (activeTurn.current) activeTurn.current.activities = work
            setActivities(work)
            if (item.kind === 'request' && item.status === 'completed') setAgentRequests(current => current.filter(active => active.requestId !== item.id))
          } else if (event.type === 'request') {
            if (event.kind === 'tool') {
              let result: unknown
              try { result = await onToolCall(String(event.params.tool ?? ''), event.params.arguments, controller.signal) }
              catch (cause) { result = { error: cause instanceof Error ? cause.message : 'PDF 工具执行失败。' } }
              if (!controller.signal.aborted && request.current === controller) await respondToAgent(event, result, controller.signal)
            } else setAgentRequests(current => [...current.filter(item => item.requestId !== event.requestId), event])
          } else if (event.type === 'complete') {
            answer = event.answer || answer || (work.length ? '本轮执行已结束，可展开查看执行记录。' : 'Codex 未返回文字回答，请重试。')
            work = work.map(item => ['running', 'inProgress'].includes(item.status) ? { ...item, status: event.status === 'completed' ? 'completed' : 'interrupted' } : item)
            if (event.status !== 'completed') {
              setError(event.status === 'interrupted' ? '任务已停止，可继续追问。' : '任务未完成，可继续追问。')
            }
            onThreadChange(event.threadId)
            onMessagesChange([...messages, userMessage, { id: crypto.randomUUID(), role: 'assistant', content: answer, ...(work.length ? { activities: work } : {}) }])
            recorded = true
            if (activeTurn.current) activeTurn.current.recorded = true
          }
        })
        return
      }
      const response = await fetch('/api/codex/ask', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify(body),
      })
      const result = await response.json() as { answer?: string; error?: string }
      if (!response.ok || !result.answer?.trim()) throw new Error(result.error || 'Codex 没有返回回答，请重试。')
      if (!controller.signal.aborted) onMessagesChange([...messages, userMessage, { id: crypto.randomUUID(), role: 'assistant', content: result.answer }])
    } catch (cause) {
      if (request.current === controller) {
        if (agent && !recorded && (answer || work.length)) onMessagesChange([...messages, userMessage, { id: crypto.randomUUID(), role: 'assistant', content: answer, activities: work.map(item => ['running', 'inProgress'].includes(item.status) ? { ...item, status: 'interrupted' } : item) }])
        else setQuestion(content)
        setError(controller.signal.aborted ? '已停止生成，可以继续提问。' : cause instanceof Error ? cause.message : '连接失败，请重试。')
      }
    } finally {
      if (request.current === controller) { request.current = null; runId.current = null; activeTurn.current = null; setBusy(false); setPending(''); setAgentAnswer(''); setActivities([]); setAgentRequests([]) }
    }
  }
  async function answerAgentRequest(active: AgentRequest, result: unknown) {
    const controller = request.current
    if (!controller || controller.signal.aborted || runId.current !== active.runId) throw new Error('这项请求已结束。')
    await respondToAgent(active, result, controller.signal)
    if (request.current === controller) setAgentRequests(current => current.filter(item => item.requestId !== active.requestId))
  }
  async function copyAnswer(message: CodexMessage) {
    try { await navigator.clipboard.writeText(message.content); setCopied(message.id) }
    catch { setError('暂时无法复制，请手动选择回答内容。') }
  }
  const connected = status?.available && status.loggedIn
  const settings = catalog ? resolveCodexSelection(catalog, preferences) : null
  const pendingUser = busy ? activeTurn.current?.user : null

  return <aside ref={panel} id={panelId} className={`codex-panel${resizing ? ' is-resizing' : ''}`} style={{ width }} aria-label="Codex 问答">
    <div className="codex-panel-resizer" aria-controls={panelId} {...separatorProps} />
    <header className="codex-heading"><button className="icon-button" aria-label="返回标注" data-tooltip="返回标注" onClick={onBack}><ArrowLeft size={16} /></button><h2>Codex<span>阅读助手</span></h2><button className="icon-button" aria-label="新建会话" data-tooltip="新建会话" onClick={() => leaveConversation(onNewConversation)}><SquarePen size={15} /></button>
      <div className="codex-history-control" ref={historyRoot}><button ref={historyButton} className={`icon-button${conversationsOpen ? ' active' : ''}`} aria-label="切换会话" aria-expanded={conversationsOpen} data-tooltip="切换会话" onClick={() => { setConnectionsOpen(false); setConversationsOpen(open => !open) }}><MessagesSquare size={15} /></button>
        {conversationsOpen && <div className="codex-conversations-menu" role="dialog" aria-label="会话列表" onKeyDown={event => {
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setConversationsOpen(false); historyButton.current?.focus(); return }
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          event.preventDefault(); event.stopPropagation()
          const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
          const selected = buttons.indexOf(document.activeElement as HTMLButtonElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (selected + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
          buttons[next]?.focus()
        }}><div className="codex-conversations-heading">当前 PDF 的会话<span>{conversations.length}</span></div><div className="codex-conversations-list">{[...conversations].sort((a, b) => b.updatedAt - a.updatedAt).map(chat => <button key={chat.id} aria-label={`切换到会话：${chat.title}`} aria-current={chat.id === conversationId ? 'true' : undefined} onClick={() => {
          setConversationsOpen(false)
          if (chat.id !== conversationId) leaveConversation(() => onSelectConversation(chat.id))
          else historyButton.current?.focus()
        }}><span className="codex-conversation-check">{chat.id === conversationId ? <Check size={13} /> : <MessageSquare size={13} />}</span><span className="codex-conversation-info"><strong>{chat.title}</strong><small>{chat.messages.length ? `${chat.messages.filter(message => message.role === 'user').length} 条提问` : '尚未开始'}<span>·</span>{new Date(chat.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></span></button>)}</div></div>}
      </div>{status?.agent && <button className={`icon-button${connectionsOpen ? ' active' : ''}`} aria-label="工具与连接" aria-expanded={connectionsOpen} data-tooltip="工具与连接" onClick={() => { setConversationsOpen(false); setConnectionsOpen(open => !open) }}><Plug size={15} /></button>}<button className="icon-button" aria-label="关闭 Codex 侧栏" data-tooltip="关闭侧栏" onClick={onClose}><X size={16} /></button></header>
    {connectionsOpen && <section className="codex-capabilities" aria-label="工具与连接状态">
      {!agentStatus && !connectionsError && <p role="status">正在读取本机运行时…</p>}
      {connectionsError && <p role="alert">{connectionsError}</p>}
      {agentStatus && <><h3>本机 Codex</h3>{agentStatus.message && <p>{agentStatus.message}</p>}<ul>{agentStatus.capabilities.filter(capability => capability.id !== 'computer_use').map(capability => <li key={capability.id} title={capability.detail}><span>{capability.label}</span><small>{capability.enabled ? '已接入' : '未启用'}</small></li>)}<li><span>桌面控制</span><small>已关闭</small></li></ul>
        {!!agentStatus.mcpServers.length && <><h3>MCP 连接</h3><ul>{agentStatus.mcpServers.map(server => <li key={server.name}><span>{server.name}</span><small>{server.status}{server.toolCount !== undefined ? ` · ${server.toolCount} 个工具` : ''}</small></li>)}</ul></>}
        {!!agentStatus.skills.length && <details><summary>技能 · {agentStatus.skills.filter(skill => skill.enabled).length} 个可用</summary><p>{agentStatus.skills.filter(skill => skill.enabled).map(skill => skill.name).join('、')}</p></details>}
        {agentStatus.warnings?.map(warning => <p key={warning}>{warning}</p>)}
      </>}
      {!!workspace && getDesktopBridge()?.openAgentFile && <button className="codex-workspace-link" onClick={() => { void getDesktopBridge()!.openAgentFile({ path: workspace }).then(result => { if (!result.ok) setError(result.error || '无法打开任务文件夹。') }).catch(cause => setError(cause instanceof Error ? cause.message : '无法打开任务文件夹。')) }}><FolderOpen size={12} />打开任务文件夹</button>}
    </section>}
    <div className="codex-conversation" role="log" aria-label="问答记录" onScroll={event => { const element = event.currentTarget; followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 60 }}>
      {!messages.length && !busy && <div className="codex-empty"><MessageSquare size={25} strokeWidth={1.3} /><h3>读到不明白的地方，就问一句。</h3><p>解释概念、翻译段落，或理清论文中的推导。</p></div>}
      {messages.map(message => <article className={`codex-message ${message.role}`} key={message.id}>
        <div className="codex-message-heading"><span>{message.role === 'user' ? '你' : 'Codex'}</span>{message.role === 'user' && message.page && <button onClick={() => onNavigate(message.page!)}>第 {message.page} 页 ↗</button>}{message.role === 'assistant' && <button className="codex-copy" aria-label="复制回答" onClick={() => void copyAnswer(message)}>{copied === message.id ? <Check size={12} /> : <Copy size={12} />}</button>}</div>
        {message.quote && <details className="codex-message-quote"><summary>引用段落</summary><blockquote>{message.quote}</blockquote></details>}
        <CodexActivityList items={message.activities ?? []} /><CodexMarkdown content={message.content} />
      </article>)}
      {busy && <><article className="codex-message user"><div className="codex-message-heading"><span>你</span>{pendingUser?.page && <button onClick={() => onNavigate(pendingUser.page!)}>第 {pendingUser.page} 页 ↗</button>}</div>{pendingUser?.quote && <details className="codex-message-quote"><summary>引用段落</summary><blockquote>{pendingUser.quote}</blockquote></details>}<p>{pending}</p></article>
        {activities.length > 0 && <CodexActivityList items={activities} busy />}
        {agentAnswer && <article className="codex-message assistant"><div className="codex-message-heading">Codex</div><CodexMarkdown content={agentAnswer} /></article>}
        {agentRequests.map(active => <CodexAgentRequest key={active.requestId} request={active} onRespond={result => answerAgentRequest(active, result)} />)}
        {!agentRequests.length && <div className="codex-thinking" role="status"><LoaderCircle className="spin" size={14} />{activities.some(item => item.status === 'running' || item.status === 'inProgress') ? '正在执行任务…' : agentAnswer ? '正在回答…' : 'Codex 正在思考…'}</div>}
      </>}
      <div ref={end} />
    </div>
    <div className="codex-compose">
      {context?.quote ? <div className="codex-source"><button onClick={() => onNavigate(context.page)}>第 {context.page} 页摘录 <span>↗</span></button><blockquote>{context.quote}</blockquote></div> : <p className="codex-no-source">直接提问，或选中文字针对摘录提问。</p>}
      {!status ? <div className="codex-connection"><LoaderCircle className="spin" size={12} />正在连接 Codex…</div> : !connected && <div className="codex-connection disconnected" role="status"><span>{status.message || '请先在本机终端运行 codex login 登录。'}</span><button onClick={() => setStatusVersion(version => version + 1)}>重试连接</button></div>}
      {context?.quote && <div className="codex-prompts">{[['解释这段', '请用中文解释这段内容，说明关键概念及其关系。'], ['翻译成中文', '请将这段内容准确翻译成中文，保留专业术语的含义。'], ['概括要点', '请用中文简要概括这段内容的要点。']].map(([label, value]) => <button key={label} disabled={!connected || busy} onClick={() => void ask(value)}>{label}</button>)}</div>}
      {error && <p className="codex-error" role="alert">{error}</p>}
      <form onSubmit={event => { event.preventDefault(); void ask() }}>
        <textarea ref={input} aria-label="向 Codex 提问" placeholder={messages.length ? '继续追问…' : context?.quote ? '想了解这段内容的什么？' : '询问当前页面，或直接提问…'} maxLength={4000} value={question} disabled={busy} onChange={event => setQuestion(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          event.preventDefault()
          if (!event.repeat) void ask()
        }} />
        <div className="codex-send-row">
          <div className="codex-settings" aria-label="Codex 生成设置">
            <div className="codex-settings-field codex-model-setting"><span className="codex-settings-label">模型</span><CodexSelect
              label="Codex 模型"
              value={settings?.model.id ?? ''}
              options={catalog ? catalog.models.map(model => ({ value: model.id, label: model.name, description: model.description })) : [{ value: '', label: 'Codex 默认' }]}
              disabled={busy || catalogState !== 'ready'}
              wide
              onChange={model => { if (catalog) setPreferences(current => normalizeCodexPreferences(catalog, { ...current, model })) }}
            /></div>
            <div className="codex-settings-field codex-reasoning-setting"><span className="codex-settings-label">思考深度</span><CodexSelect
              label="思考深度"
              value={settings?.reasoningEffort ?? ''}
              options={settings?.model.reasoningLevels.length ? settings.model.reasoningLevels.map(level => ({ value: level.id, label: level.label })) : [{ value: '', label: '自动' }]}
              disabled={busy || catalogState !== 'ready' || !settings?.model.reasoningLevels.length}
              onChange={value => {
                if (settings?.model.reasoningLevels.some(level => level.id === value)) setPreferences(current => ({ ...current, reasoningByModel: { ...current.reasoningByModel, [settings.model.id]: value } }))
              }}
            /></div>
            <button type="button" className="codex-settings-refresh" aria-label="刷新 Codex 模型" data-tooltip="刷新模型列表" disabled={busy || catalogState === 'loading'} onClick={() => setStatusVersion(version => version + 1)}><RefreshCw size={11} /></button>
          </div>
          {busy ? <button key="stop" type="button" className="codex-send" aria-label="停止生成" onClick={event => { event.preventDefault(); stopRequest() }}><Square size={12} fill="currentColor" /></button> : <button key="send" className="codex-send" aria-label="发送问题" disabled={!connected || !question.trim()}><ArrowUp size={17} /></button>}</div>
      </form>
      {catalogState !== 'ready' && <div className="codex-settings-note">{catalogState === 'loading' ? <><LoaderCircle className="spin" size={10} />读取可用模型…</> : <span>使用 Codex 默认配置</span>}</div>}
    </div>
  </aside>
}
