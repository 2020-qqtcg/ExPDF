export interface AgentActivity {
  id: string
  kind: string
  title: string
  status: string
  detail?: string
}

export interface AgentRequest {
  runId: string
  requestId: string
  kind: 'command' | 'fileChange' | 'permissions' | 'userInput' | 'elicitation' | 'tool'
  params: Record<string, unknown>
}

export interface AgentStatus {
  available: boolean
  message?: string
  desktopControl: false
  workspaceRoot?: string
  capabilities: { id: string; label: string; enabled: boolean; detail?: string }[]
  mcpServers: { name: string; status: string; toolCount?: number }[]
  skills: { name: string; enabled: boolean }[]
  warnings?: string[]
}

export type AgentEvent =
  | { type: 'thread'; runId: string; threadId: string; workspace: string }
  | { type: 'delta'; text: string }
  | { type: 'activity'; item: AgentActivity }
  | ({ type: 'request' } & AgentRequest)
  | { type: 'complete'; answer: string; threadId: string; status: string }
  | { type: 'error'; message: string }

async function responseError(response: Response) {
  const result = await response.json().catch(() => null) as { error?: string } | null
  return new Error(result?.error || `Codex 请求失败（${response.status}），请重试。`)
}

/** Read streamed work without treating model or tool output as executable UI. */
export async function runCodexAgent(body: Record<string, unknown>, signal: AbortSignal, onEvent: (event: AgentEvent) => void | Promise<void>) {
  const response = await fetch('/api/codex/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  if (!response.ok) throw await responseError(response)
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) throw new Error('Codex 未返回任务事件流，请重试。')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let completed = false
  try {
    while (true) {
      const chunk = await reader.read()
      buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replace(/\r\n/g, '\n')
      let boundary: number
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
        if (!data) continue
        let event: AgentEvent
        try { event = JSON.parse(data) as AgentEvent } catch { throw new Error('Codex 任务事件格式错误，请重试。') }
        if (event.type === 'error') throw new Error(event.message)
        if (event.type === 'complete') completed = true
        await onEvent(event)
      }
      if (buffer.length > 2 * 1024 * 1024) throw new Error('Codex 单次任务事件过大，请缩小任务范围。')
      if (chunk.done) break
    }
    if (!completed && !signal.aborted) throw new Error('Codex 连接已断开，任务尚未完成。可以继续追问。')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function respondToAgent(request: Pick<AgentRequest, 'runId' | 'requestId'>, result: unknown, signal?: AbortSignal) {
  const response = await fetch('/api/codex/agent/respond', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: request.runId, requestId: request.requestId, result }), signal })
  if (!response.ok) throw await responseError(response)
}
