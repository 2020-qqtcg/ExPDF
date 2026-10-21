#!/usr/bin/env node
// A real JSONL subprocess, not an in-process transport mock. No model is called.
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const readline = require('node:readline')
const marker = `${__filename}.events`
const record = value => fs.appendFileSync(marker, JSON.stringify(value) + '\n')
const args = process.argv.slice(2)
record({ type: 'spawn', pid: process.pid, args, cwd: process.cwd() })
if (args[0] === 'features' && args[1] === 'list') {
  console.log('computer_use experimental true\nbrowser_use experimental true\nweb_search stable true\nshell_tool stable true\napps stable true\nplugins stable true\nmulti_agent stable true')
  process.exit(0)
}
if (args[0] !== 'app-server') process.exit(2)

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
record({ type: 'grandchild', pid: grandchild.pid, parent: process.pid })
process.on('SIGTERM', () => { record({ type: 'sigterm', pid: process.pid }); process.exit(0) })
const threads = new Map()
const turns = new Map()
let nextThread = 0
let nextTurn = 0
let nextRequest = 0
const pending = new Map()
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const reply = (message, result) => send({ id: message.id, result })
const notice = (method, params) => send({ method, params })
const request = (turn, method, values, step) => {
  // Alternate numeric/string JSON-RPC ids: HTTP clients must see opaque ids.
  const id = ++nextRequest % 2 ? `server-request-${nextRequest}` : nextRequest
  pending.set(String(id), { turn, step })
  send({ id, method, params: { threadId: turn.threadId, turnId: turn.id, ...values } })
}
const tool = (turn, name, values, step) => request(turn, 'item/tool/call', { callId: `call-${nextRequest + 1}`, namespace: null, tool: name, arguments: values }, step)
const delta = (turn, text) => notice('item/agentMessage/delta', { threadId: turn.threadId, turnId: turn.id, itemId: `message-${turn.id}`, delta: text })
const finish = (turn, status = 'completed', text = '已阅读两页并保存一条批注。') => {
  if (status === 'completed') notice('item/completed', { threadId: turn.threadId, turnId: turn.id, item: { id: `message-${turn.id}`, type: 'agentMessage', text } })
  notice('turn/completed', { threadId: turn.threadId, turn: { id: turn.id, status, items: [], error: null } })
}
const runStep = (turn, step) => {
  if (step === 'read') return tool(turn, 'folio_pdf_read_pages', { startPage: 1, endPage: 2 }, 'approval')
  if (step === 'approval') return request(turn, 'item/commandExecution/requestApproval', { itemId: 'command-1', command: 'printf safe-test', cwd: process.cwd(), reason: 'Write a temporary summary', startedAtMs: Date.now(), availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] }, 'note')
  if (step === 'note') return tool(turn, 'folio_pdf_add_note', { page: 2, comment: '多步骤工具测试批注' }, 'answer')
  if (step === 'answer') {
    // Split one UTF-8 character across stdout chunks, then another JSON line.
    const message = Buffer.from(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: turn.threadId, turnId: turn.id, itemId: `message-${turn.id}`, delta: '已阅读' } }) + '\n')
    const offset = message.indexOf(Buffer.from('已')) + 1
    process.stdout.write(message.subarray(0, offset))
    return setTimeout(() => { process.stdout.write(message.subarray(offset)); delta(turn, '两页并保存一条批注。'); finish(turn) }, 8)
  }
  if (step === 'file') {
    notice('item/started', { threadId: turn.threadId, turnId: turn.id, item: { id: 'file-1', type: 'fileChange', status: 'inProgress', changes: [{ path: `${process.cwd()}/summary.md`, kind: { type: 'update' }, diff: '- old summary\n+ 新摘要\n' }] } })
    // The native approval carries only an itemId, not the earlier diff.
    return request(turn, 'item/fileChange/requestApproval', { itemId: 'file-1', reason: 'Create the requested summary', grantRoot: process.cwd(), startedAtMs: Date.now() }, 'permissions')
  }
  if (step === 'permissions') return request(turn, 'item/permissions/requestApproval', { itemId: 'permissions-1', cwd: process.cwd(), permissions: { network: { enabled: true } }, startedAtMs: Date.now() }, 'input')
  if (step === 'input') return request(turn, 'item/tool/requestUserInput', { itemId: 'input-1', isBlocking: true, questions: [{ id: 'format', header: '格式', question: '摘要需要哪种格式？', isOther: false, isSecret: false, options: [{ label: '要点', description: '项目符号摘要' }, { label: '段落', description: '连续文字摘要' }] }] }, 'elicitation')
  if (step === 'elicitation') return request(turn, 'mcpServer/elicitation/request', { serverName: 'test-research', mode: 'form', message: 'Select a report title', requestedSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } }, 'done')
  if (step === 'done') return finish(turn, 'completed', '已按所选格式整理。')
  if (step === 'desktop-done') return finish(turn, 'completed', '桌面工具请求已拒绝。')
}

readline.createInterface({ input: process.stdin }).on('line', line => {
  let message
  try { message = JSON.parse(line) } catch { return }
  record({ type: 'received', message })
  if (!message.method && message.id !== undefined) {
    const waiting = pending.get(String(message.id))
    if (waiting) { pending.delete(String(message.id)); runStep(waiting.turn, waiting.step) }
    return
  }
  if (message.method === 'initialize') return reply(message, { userAgent: 'folio-test-appserver', codexHome: '/private/fake-codex-home', platformFamily: 'unix', platformOs: 'macos' })
  if (message.method === 'initialized') return
  if (message.method === 'model/list') return reply(message, { data: [{ id: 'agent-model', model: 'agent-model', displayName: 'Agent test model', description: 'A fake model for integration tests', hidden: false, isDefault: true, inputModalities: ['text'], supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'standard' }], defaultReasoningEffort: 'medium' }], nextCursor: null })
  if (message.method === 'mcpServerStatus/list') return reply(message, { data: [{ name: 'test-research', authStatus: 'OAuth', runtimeStatus: 'connected', tools: { lookup: { name: 'lookup', inputSchema: { type: 'object' } } }, resources: [], resourceTemplates: [] }, ...(!args.some(argument => /mcp_servers\."?cua_repl"?\.enabled=false/.test(argument)) ? [{ name: 'cua_repl', authStatus: 'OAuth', runtimeStatus: 'connected', tools: { click: { name: 'click', inputSchema: { type: 'object' } } }, resources: [], resourceTemplates: [] }] : [])], nextCursor: null })
  if (message.method === 'skills/list') return reply(message, { data: [{ cwd: process.cwd(), skills: [{ name: 'research', description: 'Research skill', path: '/private/fake-skill/SKILL.md', enabled: true }], errors: [] }] })
  if (message.method === 'account/read') return reply(message, { account: { type: 'chatgpt', email: 'test@example.invalid', planType: 'plus' }, requiresOpenaiAuth: true })
  if (message.method === 'thread/start') {
    const id = `thread-${process.pid}-${++nextThread}`
    threads.set(id, message.params)
    return reply(message, { thread: { id, turns: [] }, cwd: process.cwd(), model: 'agent-model', modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false } })
  }
  if (message.method === 'thread/resume') return reply(message, { thread: { id: message.params.threadId, turns: [] }, cwd: process.cwd(), model: 'agent-model', modelProvider: 'openai', approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false } })
  if (message.method === 'turn/start') {
    const turn = { id: `turn-${++nextTurn}`, threadId: message.params.threadId, scenario: JSON.stringify(message.params.input) }
    turns.set(turn.id, turn)
    reply(message, { turn: { id: turn.id, items: [], status: 'inProgress', error: null } })
    notice('turn/started', { threadId: turn.threadId, turn: { id: turn.id, items: [], status: 'inProgress', error: null } })
    if (turn.scenario.includes('scenario:complete')) return finish(turn, 'completed', '隔离会话测试完成。')
    if (turn.scenario.includes('scenario:hold')) { delta(turn, '处理中'); return }
    if (turn.scenario.includes('scenario:requests')) return runStep(turn, 'file')
    if (turn.scenario.includes('scenario:desktop-command')) return request(turn, 'item/commandExecution/requestApproval', { itemId: 'desktop-command', command: 'osascript -e \'tell application "System Events" to keystroke "x"\'', cwd: process.cwd(), startedAtMs: Date.now() }, 'desktop-done')
    if (turn.scenario.includes('scenario:desktop')) return tool(turn, 'computer_use', { action: 'click', x: 2, y: 3 }, 'desktop-done')
    return tool(turn, 'folio_pdf_get_document', {}, turn.scenario.includes('scenario:pending') ? 'done' : 'read')
  }
  if (message.method === 'turn/interrupt') {
    reply(message, {})
    const turn = turns.get(message.params.turnId)
    if (turn) {
      if (turn.scenario.includes('ignore-interrupt')) return
      if (turn.scenario.includes('slow-interrupt')) return setTimeout(() => finish(turn, 'interrupted'), 400)
      finish(turn, 'interrupted')
      setTimeout(() => delta(turn, '迟到的内容不应继续进入浏览器'), 15)
    }
    return
  }
  if (message.id !== undefined) reply(message, {})
})
