import assert from 'node:assert/strict'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createCodexAgentRuntime } from '../server/codex-agent.mjs'

type Event = { type: string; runId?: string; requestId?: string; threadId?: string; kind?: string; params?: Record<string, unknown>; [key: string]: unknown }
type Rpc = { id?: string | number; method?: string; params?: Record<string, any>; result?: any; error?: unknown }
type RecordLine = { type: string; pid?: number; args?: string[]; message?: Rpc; [key: string]: unknown }
const question = { documentId: 'test-document-alpha', documentName: '代理测试.pdf', page: 2, quote: 'A selected paragraph.', pageText: 'The supplied second-page context.', question: 'scenario:multi 请读两页并整理批注。', messages: [], model: 'agent-model', reasoningEffort: 'medium' }

async function until(check: () => boolean | Promise<boolean>, message: string, timeout = 5_000) {
  const end = Date.now() + timeout
  do {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 12))
  } while (Date.now() < end)
  assert.fail(message)
}

class EventStream {
  readonly events: Event[] = []
  readonly done: Promise<void>
  constructor(readonly response: Response) {
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    this.done = this.read()
  }
  private async read() {
    const reader = this.response.body!.getReader()
    const decoder = new TextDecoder()
    let text = ''
    try {
      while (true) {
        const chunk = await reader.read()
        text += decoder.decode(chunk.value, { stream: !chunk.done }).replaceAll('\r\n', '\n')
        let boundary
        while ((boundary = text.indexOf('\n\n')) >= 0) {
          const frame = text.slice(0, boundary)
          text = text.slice(boundary + 2)
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (data) this.events.push(JSON.parse(data))
        }
        if (chunk.done) return
      }
    } catch (error) {
      if (!(error instanceof Error) || !/abort|terminat|closed/i.test(error.message)) throw error
    } finally { reader.releaseLock() }
  }
  async event(predicate: (event: Event) => boolean, label: string) {
    await until(() => this.events.some(predicate), `${label}; observed ${JSON.stringify(this.events)}`)
    return this.events.find(predicate)!
  }
  request(kind: string) { return this.event(event => event.type === 'request' && event.kind === kind, `${kind} request`) }
}

async function harness(options: { timeoutMs?: number; rpcTimeoutMs?: number; legacyRegistry?: Record<string, string> } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'folio-agent-test-'))
  const executable = path.join(folder, 'fake-codex.cjs')
  const workspace = path.join(folder, 'workspace')
  await mkdir(workspace)
  if (options.legacyRegistry) await writeFile(path.join(workspace, 'folio-threads.json'), JSON.stringify(options.legacyRegistry))
  await copyFile(new URL('./fixtures/fake-codex-appserver.cjs', import.meta.url), executable)
  await chmod(executable, 0o700)
  const createRuntime = () => createCodexAgentRuntime({ executable, workspaceRoot: workspace, timeoutMs: options.timeoutMs ?? 10_000, rpcTimeoutMs: options.rpcTimeoutMs ?? 2_000 })
  let runtime = createRuntime()
  const server = http.createServer((request, response) => {
    Promise.resolve(runtime.middleware(request, response, () => { response.writeHead(404); response.end() })).catch(error => {
      if (!response.headersSent) response.writeHead(500)
      response.end(String(error))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (endpoint: string, body: unknown, init: RequestInit = {}) => fetch(`${base}/api/codex/agent/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...init })
  const records = async (): Promise<RecordLine[]> => {
    const text = await readFile(`${executable}.events`, 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await runtime.close()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    const children = (await records()).filter(record => ['spawn', 'grandchild'].includes(record.type)).map(record => record.pid!).filter(Boolean)
    await until(() => children.every(pid => { try { process.kill(pid, 0); return false } catch { return true } }), `Agent process tree leaked: ${children.join(', ')}`)
    await rm(folder, { recursive: true, force: true })
  }
  const run = async (body: Record<string, unknown> = question, signal?: AbortSignal) => {
    const response = await post('run', body, { signal })
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/, `Expected an SSE stream, got ${response.status} ${await (!response.headers.get('content-type')?.includes('text/event-stream') ? response.text() : Promise.resolve(''))}; last RPC messages: ${JSON.stringify((await records()).slice(-12).map(record => ({ type: record.type, id: record.message?.id, method: record.message?.method, threadId: record.message?.params?.threadId, turnId: record.message?.params?.turnId })))}`)
    return new EventStream(response)
  }
  const restart = async () => { await runtime.close(); runtime = createRuntime() }
  return { base, workspace, runtime, post, records, close, run, restart }
}

test('agent discovery uses the local app-server and rejects cross-origin, forged-host, and injected launch settings', { timeout: 20_000 }, async () => {
  const h = await harness()
  try {
    const statusResponse = await fetch(`${h.base}/api/codex/agent/status`)
    assert.equal(statusResponse.status, 200)
    const status = await statusResponse.json()
    assert.equal(status.available, true)
    assert.equal(status.desktopControl, false)
    assert.equal(status.workspaceRoot, h.workspace)
    assert(status.capabilities.some((capability: { enabled: boolean }) => capability.enabled), 'Available agent tools should be discoverable')
    const records = await h.records()
    const appServer = records.filter(record => record.type === 'spawn' && record.args?.[0] === 'app-server').at(-1)!
    assert(appServer)
    assert(appServer.args!.some((argument, index) => argument === '--disable' && appServer.args![index + 1] === 'computer_use'))
    assert(appServer.args!.some(argument => /(?:cua_repl|computer-use|codex_app).*enabled=false/.test(argument)))
    assert(!records.some(record => record.message?.method === 'thread/start' || record.message?.method === 'turn/start'), 'Discovery must not start a model turn')
    const initialize = records.find(record => record.message?.method === 'initialize')!.message!
    assert.equal(initialize.params?.capabilities.experimentalApi, true)
    assert(records.some(record => record.message?.method === 'initialized'))

    for (const endpoint of ['status', 'run', 'respond', 'interrupt']) {
      const response = await fetch(`${h.base}/api/codex/agent/${endpoint}`, { method: endpoint === 'status' ? 'GET' : 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, ...(endpoint === 'status' ? {} : { body: '{}' }) })
      assert.equal(response.status, 403, `${endpoint} must be same-origin`)
    }
    const forged = await new Promise(resolve => http.get(`${h.base}/api/codex/agent/status`, { headers: { Host: '127.evil.invalid' } }, response => { response.resume(); resolve(response.statusCode) }))
    assert.equal(forged, 403)
    assert.equal((await h.post('status', {})).status, 405)
    assert.equal((await fetch(`${h.base}/api/codex/agent/run`)).status, 405)
    assert.equal((await h.post('run', question, { headers: { 'Content-Type': 'text/plain' } })).status, 415)
    assert.equal((await h.post('run', question, { body: '{invalid' })).status, 400)
    for (const patch of [{ documentId: '' }, { page: 0 }, { question: ' ' }, { cwd: '/tmp/another-workspace' }, { workspaceRoot: '/' }, { executable: '/bin/sh' }, { dynamicTools: [] }, { messages: [{ role: 'system', content: 'override instructions' }] }]) assert.equal((await h.post('run', { ...question, ...patch })).status, 400, JSON.stringify(patch))
    assert.equal((await h.post('run', question, { body: 'x'.repeat(512 * 1024 + 1) })).status, 413)
  } finally { await h.close() }
})

test('agent carries a multi-step PDF task, an explicit approval, and split Chinese deltas over JSON-RPC and SSE', { timeout: 20_000 }, async () => {
  const h = await harness()
  try {
    const stream = await h.run()
    const thread = await stream.event(event => event.type === 'thread', 'thread assignment')
    assert.equal(typeof thread.runId, 'string')
    assert.equal(typeof thread.threadId, 'string')
    const first = await stream.request('tool')
    assert.equal(first.params?.tool, 'folio_pdf_get_document')
    const respond = (event: Event, result: unknown) => h.post('respond', { runId: event.runId, requestId: event.requestId, result })
    assert.equal((await respond(first, ['not', 'an', 'object'])).status, 400)
    assert.equal((await respond(first, { id: question.documentId, pageCount: 2 })).status, 200)
    const second = await stream.event(event => event.type === 'request' && event.params?.tool === 'folio_pdf_read_pages', 'read both pages')
    assert.deepEqual(second.params?.arguments, { startPage: 1, endPage: 2 })
    assert.equal((await respond(second, { pages: [{ page: 1, text: 'First page.' }, { page: 2, text: 'Second page.' }] })).status, 200)
    const approval = await stream.request('command')
    assert.equal(approval.params?.command, 'printf safe-test')
    assert.equal((await respond(approval, { decision: 'accept' })).status, 200)
    const note = await stream.event(event => event.type === 'request' && event.params?.tool === 'folio_pdf_add_note', 'create a note after reading')
    assert.deepEqual(note.params?.arguments, { page: 2, comment: '多步骤工具测试批注' })
    assert.equal((await respond(note, { annotationId: 'new-note', page: 2, saved: true })).status, 200)
    const complete = await stream.event(event => event.type === 'complete', 'completed turn')
    assert.equal(complete.status, 'completed')
    assert.equal(complete.answer, '已阅读两页并保存一条批注。')
    await stream.done
    assert.equal(stream.events.filter(event => event.type === 'delta').map(event => event.text).join(''), complete.answer)
    assert.equal(stream.events.filter(event => event.type === 'complete').length, 1)
    assert(stream.events.every(event => !event.runId || event.runId === thread.runId))
    const records = await h.records()
    const threadStart = records.find(record => record.message?.method === 'thread/start')!.message!.params!
    assert.equal(path.dirname(threadStart.cwd), h.workspace, 'Each PDF must receive a separate local workspace')
    assert.equal(thread.workspace, threadStart.cwd)
    assert.equal(threadStart.sandbox, 'workspace-write')
    assert.equal(threadStart.approvalPolicy, 'on-request')
    assert.equal(threadStart.approvalsReviewer, 'user')
    const tools = threadStart.dynamicTools.map((tool: { name: string }) => tool.name)
    for (const name of ['folio_pdf_get_document', 'folio_pdf_read_pages', 'folio_pdf_search', 'folio_pdf_list_annotations', 'folio_pdf_navigate_page', 'folio_pdf_add_note', 'folio_pdf_highlight_text']) assert(tools.includes(name), name)
    assert(!tools.some((name: string) => /desktop|computer|click|keyboard/i.test(name)))
    const responses = records.filter(record => record.type === 'received' && record.message?.id !== undefined && !record.message.method).map(record => record.message!)
    assert.deepEqual(responses[0].result, { success: true, contentItems: [{ type: 'inputText', text: JSON.stringify({ id: question.documentId, pageCount: 2 }) }] })
    assert.deepEqual(responses[2].result, { decision: 'accept' })
    assert.equal((await respond(first, { pageCount: 999 })).status, 409, 'Consumed request IDs cannot be replayed')
  } finally { await h.close() }
})

test('agent scopes request replies to their live run and binds resumed threads to the original PDF', { timeout: 20_000 }, async () => {
  const h = await harness()
  try {
    const stream = await h.run({ ...question, question: 'scenario:pending' })
    const request = await stream.request('tool')
    const thread = await stream.event(event => event.type === 'thread', 'thread assignment')
    assert.equal((await h.post('respond', { runId: 'unknown-run', requestId: request.requestId, result: { pageCount: 2 } })).status, 409)
    assert.equal((await h.post('respond', { runId: request.runId, requestId: 'unknown-request', result: {} })).status, 409)
    assert.equal((await h.post('respond', { runId: request.runId, requestId: request.requestId, result: () => undefined, command: 'injected' })).status, 400)
    const interrupted = await h.post('interrupt', { runId: request.runId })
    assert.equal(interrupted.status, 200)
    await stream.event(event => event.type === 'complete', 'interrupted turn')
    await stream.done
    assert.equal((await h.post('respond', { runId: request.runId, requestId: request.requestId, result: {} })).status, 409, 'A stale PDF tool result must never reach the agent')
    assert.equal((await h.post('run', { ...question, documentId: 'test-document-beta', threadId: thread.threadId })).status, 409)
    assert.equal((await h.post('run', { ...question, threadId: 'thread-not-issued-by-folio' })).status, 409)
    const next = await h.run({ ...question, threadId: thread.threadId, question: 'scenario:hold same document follow-up' })
    const nextThread = await next.event(event => event.type === 'thread', 'reused thread')
    assert.equal(nextThread.threadId, thread.threadId)
    assert.notEqual(nextThread.runId, thread.runId)
    assert.equal((await h.post('interrupt', { runId: nextThread.runId })).status, 200)
    await next.done
    const replies = (await h.records()).filter(record => record.type === 'received' && record.message?.id !== undefined && !record.message.method)
    assert(!replies.some(record => JSON.stringify(record.message).includes('injected')))
  } finally { await h.close() }
})

test('agent relays typed approvals and user input while denying an unregistered desktop-control tool', { timeout: 20_000 }, async () => {
  const h = await harness()
  try {
    const stream = await h.run({ ...question, question: 'scenario:requests' })
    for (const [kind, result] of [
      ['fileChange', { decision: 'decline' }],
      ['permissions', { permissions: {}, scope: 'turn' }],
      ['userInput', { answers: { format: { answers: ['要点'] } } }],
      ['elicitation', { action: 'accept', content: { title: '阅读摘要' } }],
    ] as const) {
      const event = await stream.request(kind)
      if (kind === 'fileChange') {
        const changes = event.params?.changes as { path: string; diff: string }[]
        assert.equal(changes.length, 1, 'An approval must include the earlier item diff even when the RPC request contains only its itemId')
        assert.match(changes[0].path, /summary\.md$/)
        assert.equal(changes[0].diff, '- old summary\n+ 新摘要\n')
        assert(Buffer.byteLength(JSON.stringify(event)) <= 32 * 1024)
        assert.equal((await h.post('respond', { runId: event.runId, requestId: event.requestId, result: { decision: 'run-arbitrary-command' } })).status, 400)
      }
      if (kind === 'permissions') assert.equal((await h.post('respond', { runId: event.runId, requestId: event.requestId, result: { permissions: { fileSystem: { write: ['/'] } }, scope: 'session' } })).status, 400, 'A reply must not enlarge the requested access')
      if (kind === 'userInput') assert.equal((await h.post('respond', { runId: event.runId, requestId: event.requestId, result: { answers: { unrequested: { answers: ['injected'] } } } })).status, 400)
      if (kind === 'elicitation') assert.equal((await h.post('respond', { runId: event.runId, requestId: event.requestId, result: { action: 'accept', content: { title: 42 } } })).status, 400, 'Connected-service replies must respect the requested schema')
      assert.equal((await h.post('respond', { runId: event.runId, requestId: event.requestId, result })).status, 200, kind)
    }
    assert.equal((await stream.event(event => event.type === 'complete', 'all request types completed')).answer, '已按所选格式整理。')
    await stream.done
    const desktop = await h.run({ ...question, question: 'scenario:desktop' })
    await desktop.event(event => ['complete', 'error'].includes(event.type), 'desktop request denied')
    await desktop.done
    assert(!desktop.events.some(event => event.type === 'request' && event.kind === 'tool'), 'No desktop-control request should ever be dispatched to the renderer')
    const rejected = (await h.records()).find(record => record.type === 'received' && record.message?.result?.success === false)
    assert(rejected, 'Unknown tools must receive an explicit failed tool result')
    assert.match(JSON.stringify(rejected.message), /disabled|not allowed|unsupported|禁止|不支持|未注册/i)
    const desktopCommand = await h.run({ ...question, question: 'scenario:desktop-command' })
    await desktopCommand.event(event => ['complete', 'error'].includes(event.type), 'desktop automation command denied')
    await desktopCommand.done
    assert(!desktopCommand.events.some(event => event.type === 'request' && event.kind === 'command'), 'A shell approval must not bypass the desktop-control restriction')
    assert((await h.records()).some(record => record.type === 'received' && record.message?.result?.decision === 'decline'))
  } finally { await h.close() }
})

test('agent interrupts disconnected SSE clients, times out stalled turns, and cleans up its complete subprocess tree', { timeout: 25_000 }, async () => {
  const h = await harness({ timeoutMs: 700, rpcTimeoutMs: 500 })
  try {
    const controller = new AbortController()
    const stream = await h.run({ ...question, question: 'scenario:hold disconnect' }, controller.signal)
    const first = await stream.event(event => event.type === 'thread', 'started cancellable turn')
    await stream.event(event => event.type === 'delta', 'started response before disconnect')
    controller.abort()
    await stream.done
    await until(async () => (await h.records()).some(record => record.message?.method === 'turn/interrupt'), 'Closing an SSE connection did not interrupt its model turn')
    const timed = await h.run({ ...question, question: 'scenario:hold ignore-interrupt timeout' })
    await timed.event(event => ['error', 'complete'].includes(event.type), 'timeout event')
    await timed.done
    assert(timed.events.some(event => event.type === 'error' || event.status !== 'completed'))
    assert.notEqual(timed.events.find(event => event.type === 'thread')?.runId, first.runId)
  } finally { await h.close() }
})

test('agent conversations keep separate threads, histories, workspaces and live locks for the same PDF', { timeout: 25_000 }, async () => {
  const h = await harness()
  const firstId = randomUUID(), secondId = randomUUID(), thirdId = randomUUID()
  try {
    for (const conversationId of ['', null, 42, {}, 'new-chat', '../legacy', '00000000-0000-0000-0000-000000000000']) {
      assert.equal((await h.post('run', { ...question, conversationId })).status, 400)
    }
    const complete = async (conversationId: string, content: string, threadId?: string) => {
      const stream = await h.run({ ...question, conversationId, ...(threadId ? { threadId } : {}), question: 'scenario:complete', messages: [{ role: 'user', content }] })
      const thread = await stream.event(event => event.type === 'thread', 'conversation thread')
      await stream.event(event => event.type === 'complete', 'conversation completion')
      await stream.done
      return thread
    }
    const first = await complete(firstId, 'ONLY-FIRST-CONVERSATION')
    const second = await complete(secondId, 'ONLY-SECOND-CONVERSATION')
    assert.notEqual(first.threadId, second.threadId)
    assert.notEqual(first.workspace, second.workspace)
    assert.equal(path.dirname(first.workspace as string), h.workspace)
    assert.equal(path.dirname(second.workspace as string), h.workspace)
    const firstAgain = await complete(firstId.toUpperCase(), 'DUPLICATE-HISTORY-MUST-NOT-BE-INJECTED', first.threadId)
    assert.equal(firstAgain.threadId, first.threadId)
    assert.equal(firstAgain.workspace, first.workspace)
    const turns = (await h.records()).filter(record => record.message?.method === 'turn/start').map(record => record.message!.params!)
    assert.equal(turns.length, 3)
    assert.match(JSON.stringify(turns[0].input), /ONLY-FIRST-CONVERSATION/)
    assert(!JSON.stringify(turns[0].input).includes('ONLY-SECOND-CONVERSATION'))
    assert.match(JSON.stringify(turns[1].input), /ONLY-SECOND-CONVERSATION/)
    assert(!JSON.stringify(turns[1].input).includes('ONLY-FIRST-CONVERSATION'))
    assert(!JSON.stringify(turns[2].input).includes('DUPLICATE-HISTORY-MUST-NOT-BE-INJECTED'), 'A resumed native thread already owns its history')
    for (const turn of turns) assert.match(turn.input[0].text, new RegExp(`"documentId":"${question.documentId}"`), 'PDF tools must receive the real document ID, never a composite conversation key')
    for (const patch of [{ conversationId: secondId }, { conversationId: 'legacy' }, { conversationId: thirdId }, { documentId: 'another-pdf', conversationId: firstId }]) {
      assert.equal((await h.post('run', { ...question, ...patch, threadId: first.threadId })).status, 409, 'A native thread cannot be borrowed by another conversation')
    }

    const heldFirst = await h.run({ ...question, conversationId: firstId, question: 'scenario:hold slow-interrupt' })
    const heldFirstThread = await heldFirst.event(event => event.type === 'thread', 'held first conversation')
    const heldSecond = await h.run({ ...question, conversationId: secondId, question: 'scenario:hold' })
    const heldSecondThread = await heldSecond.event(event => event.type === 'thread', 'held second conversation')
    assert.equal(heldFirstThread.threadId, first.threadId)
    assert.equal(heldSecondThread.threadId, second.threadId)
    assert.equal((await h.post('run', { ...question, conversationId: thirdId })).status, 429, 'Global concurrency remains bounded at two')
    await h.post('interrupt', { runId: heldSecondThread.runId }); await heldSecond.done
    await h.post('interrupt', { runId: heldFirstThread.runId })
    const third = await h.run({ ...question, conversationId: thirdId, question: 'scenario:hold' })
    const thirdThread = await third.event(event => event.type === 'thread', 'new conversation during old cancellation')
    assert.notEqual(thirdThread.threadId, first.threadId)
    await heldFirst.done
    assert.equal((await h.post('run', { ...question, conversationId: thirdId })).status, 409, 'Only the same conversation has an exclusive busy lock')
    await h.post('interrupt', { runId: thirdThread.runId }); await third.done
  } finally { await h.close() }
})

test('agent preserves the v1 default thread and workspace while persisting UUID conversations across runtime restarts', { timeout: 25_000 }, async () => {
  const oldThread = 'legacy-thread-existing'
  const h = await harness({ legacyRegistry: { [question.documentId]: oldThread } })
  const conversationId = randomUUID()
  try {
    const legacyWorkspace = path.join(h.workspace, createHash('sha256').update(question.documentId).digest('hex'))
    await mkdir(legacyWorkspace)
    const oldFile = path.join(legacyWorkspace, 'existing-summary.txt')
    await writeFile(oldFile, 'Keep this existing workspace.')
    const complete = async (patch: Record<string, unknown>) => {
      const stream = await h.run({ ...question, question: 'scenario:complete', ...patch })
      const thread = await stream.event(event => event.type === 'thread', 'restored conversation')
      await stream.event(event => event.type === 'complete', 'restored completion'); await stream.done
      return thread
    }
    const legacy = await complete({})
    assert.equal(legacy.threadId, oldThread)
    assert.equal(legacy.workspace, legacyWorkspace)
    const created = await complete({ conversationId })
    assert.notEqual(created.threadId, oldThread)
    assert.notEqual(created.workspace, legacyWorkspace)
    const persisted = JSON.parse(await readFile(path.join(h.workspace, 'folio-threads.json'), 'utf8'))
    assert.equal(persisted[question.documentId], oldThread, 'V1 document mappings stay readable by existing Folio versions')
    assert.equal(persisted.$version, 2)
    assert.deepEqual(persisted.$conversations, [{ documentId: question.documentId, conversationId, threadId: created.threadId }])
    await h.restart()
    const restoredNew = await complete({ conversationId })
    const restoredLegacy = await complete({ conversationId: 'legacy' })
    assert.equal(restoredNew.threadId, created.threadId)
    assert.equal(restoredNew.workspace, created.workspace)
    assert.equal(restoredLegacy.threadId, oldThread)
    assert.equal(restoredLegacy.workspace, legacyWorkspace)
    assert.equal(await readFile(oldFile, 'utf8'), 'Keep this existing workspace.')
    assert.equal((await h.post('run', { ...question, conversationId, threadId: oldThread })).status, 409)
    assert.equal((await h.post('run', { ...question, threadId: created.threadId })).status, 409)
    const records = await h.records()
    const starts = records.filter(record => record.message?.method === 'thread/start')
    assert.equal(starts.length, 1, 'Only the new UUID conversation starts a fresh native thread')
    const resumes = records.filter(record => record.message?.method === 'thread/resume').map(record => record.message!.params!.threadId)
    assert.deepEqual(resumes, [oldThread, created.threadId, oldThread])
  } finally { await h.close() }
})
