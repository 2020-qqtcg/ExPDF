import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { chooseCodexOption } from './helpers/codex'
import { selectTool, showAnnotations, useFixedZoom } from './helpers/reader'

type Json = Record<string, any>

async function mockAgent(page: Page) {
  const replies: Json[] = [], interruptions: Json[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true, agent: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: { defaultModel: 'conversation-model', models: [{ id: 'conversation-model', name: 'Conversation model', reasoningLevels: [{ id: 'medium', label: '标准' }, { id: 'high', label: '深入' }], defaultReasoningLevel: 'medium' }] } }))
  await page.route('**/api/codex/agent/status*', route => route.fulfill({ json: { available: true, desktopControl: false, capabilities: [], mcpServers: [], skills: [] } }))
  await page.route('**/api/codex/agent/respond', route => { replies.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/codex/agent/interrupt', route => { interruptions.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/codex/ask', route => route.fulfill({ status: 500, json: { error: 'A conversation test must never invoke a real or legacy model.' } }))
  // Keep independent byte streams alive so switching chats exercises the real
  // SSE reader and AbortSignal, rather than invoking a React callback directly.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    const streams: any[] = []
    ;(window as any).__conversationStreams = streams
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url, location.href).pathname !== '/api/codex/agent/run') return original(input, init)
      const item: any = { body: JSON.parse(String(init?.body)), aborted: false }
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        item.controller = controller
        init?.signal?.addEventListener('abort', () => { item.aborted = true; try { controller.error(new DOMException('Aborted', 'AbortError')) } catch { /* Stream already ended. */ } }, { once: true })
      }, cancel() { item.aborted = true } })
      streams.push(item)
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    }
  })
  const calls = () => page.evaluate(() => (window as any).__conversationStreams.map((stream: any) => ({ body: stream.body, aborted: stream.aborted })))
  const emit = (index: number, event: Json, close = false) => page.evaluate(({ index, event, close }) => {
    const stream = (window as any).__conversationStreams[index]
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    try { for (let offset = 0; offset < bytes.length; offset += 11) stream.controller.enqueue(bytes.slice(offset, offset + 11)); if (close) stream.controller.close(); return true } catch { return false }
  }, { index, event, close })
  const finish = async (index: number, runId: string, threadId: string, answer: string) => {
    await emit(index, { type: 'thread', runId, threadId, workspace: '/private/test-conversation-workspace' })
    await emit(index, { type: 'complete', runId, threadId, status: 'completed', answer }, true)
    await expect(page.getByRole('complementary', { name: 'Codex 问答' }).getByRole('textbox', { name: '向 Codex 提问' })).toBeEnabled()
  }
  const send = async (question: string, index: number) => {
    const panel = page.getByRole('complementary', { name: 'Codex 问答' })
    await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill(question)
    await panel.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect.poll(async () => (await calls()).length).toBe(index + 1)
    return (await calls())[index].body as Json
  }
  return { calls, emit, finish, send, replies, interruptions }
}

async function pdfFixture(label: string) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  const sheet = pdf.addPage([612, 792])
  sheet.drawText(`${label}: careful reading and independent conversations.`, { x: 56, y: 720, size: 17, font })
  sheet.drawText('A source sentence must stay attached to its original question.', { x: 56, y: 680, size: 13, font })
  return Buffer.from(await pdf.save())
}

async function openFixture(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'conversations.pdf', mimeType: 'application/pdf', buffer: await pdfFixture('Conversations') })
  await expect(page.locator('#page-1 .textLayer')).toContainText('Conversations:')
  await useFixedZoom(page)
}

async function openPanel(page: Page) {
  await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Codex 问答' }).getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
}

async function switchChat(page: Page, title: string) {
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  await panel.getByRole('button', { name: '切换会话', exact: true }).click()
  const choice = panel.getByRole('button', { name: `切换到会话：${title}`, exact: true })
  await expect(choice).toBeVisible()
  await choice.click()
  await expect(panel.getByRole('button', { name: `切换到会话：${title}`, exact: true })).toHaveCount(0)
}

test('keeps independent chat histories and server threads, preserving the active chat, model, and panel width after reloading', async ({ page }) => {
  const fake = await mockAgent(page)
  await openFixture(page)
  await selectTool(page, '选择文本')
  await page.locator('#page-1 .textLayer span').first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('toolbar', { name: '选中文字工具', exact: true }).getByRole('button', { name: '问 Codex', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  await expect(panel.locator('.codex-source blockquote')).toContainText('Conversations:')
  await expect(panel.getByRole('combobox', { name: '思考深度', exact: true })).toBeEnabled()
  await chooseCodexOption(page, '思考深度', '深入')
  await panel.getByRole('separator', { name: '调整 Codex 侧栏宽度' }).press('Shift+ArrowLeft')
  const width = (await panel.boundingBox())!.width
  const first = await fake.send('论证的前提是什么', 0)
  expect(first).toMatchObject({ conversationId: 'legacy', messages: [], reasoningEffort: 'high' })
  expect(first.quote).toContain('Conversations:')
  await fake.finish(0, 'run-first', 'thread-first', '第一会话：前提需要结合原文核对。')
  await panel.getByRole('button', { name: '新建会话', exact: true }).click()
  await expect(panel.locator('.codex-message')).toHaveCount(0)
  await expect(panel.locator('.codex-source')).toHaveCount(0)
  await expect(panel.getByRole('combobox', { name: '思考深度', exact: true })).toContainText('深入')
  expect((await panel.boundingBox())!.width).toBeCloseTo(width, 0)
  const second = await fake.send('换个角度概括这篇文章', 1)
  expect(second.documentId).toBe(first.documentId)
  expect(second.conversationId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/i)
  expect(second.conversationId).not.toBe(first.conversationId)
  expect(second).toMatchObject({ messages: [], quote: '', reasoningEffort: 'high' })
  expect(second.threadId).toBeUndefined()
  await fake.finish(1, 'run-second', 'thread-second', '第二会话：独立概括文章的主旨。')
  await switchChat(page, '论证的前提是什么')
  await expect(panel.locator('.codex-message.assistant')).toHaveText(/第一会话/)
  await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('第二会话')
  await expect(panel.locator('.codex-source')).toHaveCount(0)
  const followUp = await fake.send('请继续说明这些前提', 2)
  expect(followUp).toMatchObject({ conversationId: 'legacy', threadId: 'thread-first' })
  expect(followUp.messages.map((message: Json) => message.role)).toEqual(['user', 'assistant'])
  expect(JSON.stringify(followUp.messages)).not.toContain('第二会话')
  await fake.finish(2, 'run-followup', 'thread-first', '第一会话追问：继续核对推理条件。')
  await switchChat(page, '换个角度概括这篇文章')
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(page.locator('#page-1 .textLayer')).toContainText('Conversations:')
  await openPanel(page)
  await expect(panel.locator('.codex-message.assistant')).toHaveText(/第二会话/)
  await expect(panel.getByRole('combobox', { name: '思考深度', exact: true })).toContainText('深入')
  expect((await panel.boundingBox())!.width).toBeCloseTo(width, 0)
  await panel.getByRole('button', { name: '切换会话', exact: true }).click()
  const active = panel.getByRole('button', { name: '切换到会话：换个角度概括这篇文章', exact: true })
  await expect(active).toHaveAttribute('aria-current', /^(true|page)$/)
  await expect(panel.getByRole('button', { name: /^切换到会话：/ })).toHaveCount(2)
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/codex-conversations-reader.png' })
  await panel.getByRole('button', { name: '切换到会话：论证的前提是什么', exact: true }).click()
  await expect(panel.locator('.codex-message.assistant')).toHaveCount(2)
  await expect(panel.locator('.codex-message.assistant').last()).toContainText('第一会话追问')
})

test('cancels a busy chat on create or switch without applying late text or PDF tools to the next conversation', async ({ page }) => {
  const fake = await mockAgent(page)
  await openFixture(page)
  await openPanel(page)
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  const old = await fake.send('保留第一会话的进行中任务', 0)
  await fake.emit(0, { type: 'thread', runId: 'run-pending-old', threadId: 'thread-old', workspace: '/private/test-conversation-workspace' })
  await fake.emit(0, { type: 'delta', runId: 'run-pending-old', text: '第一会话已经得到的部分回答。' })
  await expect(panel.getByRole('log', { name: '问答记录' })).toContainText('第一会话已经得到')
  await panel.getByRole('button', { name: '新建会话', exact: true }).click()
  await expect.poll(async () => (await fake.calls())[0].aborted).toBe(true)
  await expect.poll(() => fake.interruptions.some(call => call.runId === 'run-pending-old')).toBe(true)
  await expect(panel.locator('.codex-message')).toHaveCount(0)
  expect(await fake.emit(0, { type: 'delta', text: '错误地进入新会话的迟到回答' })).toBe(false)
  const current = await fake.send('第二会话的进行中任务', 1)
  expect(current.conversationId).not.toBe(old.conversationId)
  expect(current.messages).toEqual([])
  expect(current.threadId).toBeUndefined()
  await fake.emit(1, { type: 'thread', runId: 'run-pending-new', threadId: 'thread-new', workspace: '/private/test-conversation-workspace' })
  await fake.emit(1, { type: 'request', runId: 'run-pending-new', requestId: 'valid-current-note', kind: 'tool', params: { tool: 'folio_pdf_add_note', arguments: { page: 1, comment: '切换前已完成的合法批注' } } })
  await expect.poll(() => fake.replies.some(reply => reply.requestId === 'valid-current-note' && reply.result.ok)).toBe(true)
  await switchChat(page, '保留第一会话的进行中任务')
  await expect.poll(async () => (await fake.calls())[1].aborted).toBe(true)
  await expect.poll(() => fake.interruptions.some(call => call.runId === 'run-pending-new')).toBe(true)
  expect(await fake.emit(1, { type: 'request', runId: 'run-pending-new', requestId: 'late-note', kind: 'tool', params: { tool: 'folio_pdf_add_note', arguments: { page: 1, comment: '已经失效的会话不得添加这条批注' } } })).toBe(false)
  await expect(panel.getByRole('log', { name: '问答记录' })).toContainText('第一会话已经得到的部分回答')
  await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('第二会话的进行中任务')
  await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('迟到回答')
  const resumed = await fake.send('继续第一会话', 2)
  expect(resumed).toMatchObject({ conversationId: old.conversationId, threadId: 'thread-old' })
  expect(JSON.stringify(resumed.messages)).toContain('第一会话已经得到的部分回答')
  expect(JSON.stringify(resumed.messages)).not.toContain('第二会话')
  await fake.finish(2, 'run-old-resumed', 'thread-old', '第一会话已继续。')
  expect(fake.replies.some(reply => reply.requestId === 'late-note')).toBe(false)
  await showAnnotations(page)
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toContainText('切换前已完成的合法批注')
})

test('migrates an existing single-chat document without losing its messages or server thread, and keeps new chats separate', async ({ page }) => {
  const fake = await mockAgent(page)
  const bytes = await pdfFixture('Legacy')
  const documentId = createHash('sha256').update(bytes).digest('hex')
  await page.route('**/__conversation-seed', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Storage fixture</title>' }))
  await page.goto('/__conversation-seed')
  await page.evaluate(async ({ documentId, bytes }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('folio-reader', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('sessions', { keyPath: 'id' })
        request.result.createObjectStore('recents', { keyPath: 'id' }).createIndex('updatedAt', 'updatedAt')
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const transaction = database.transaction(['sessions', 'recents'], 'readwrite')
    const original = { id: documentId, name: 'legacy-conversation.pdf', bytes: new Uint8Array(bytes), annotations: [], bookmarks: [], lastPage: 1, codexMessages: [{ id: 'legacy-user', role: 'user', content: '迁移前的提问', page: 1, quote: 'Legacy: careful reading and independent conversations.' }, { id: 'legacy-answer', role: 'assistant', content: '迁移前保存的回答内容。' }], codexThreadId: 'legacy-server-thread', updatedAt: Date.now() }
    transaction.objectStore('sessions').put(original)
    transaction.objectStore('recents').put({ id: documentId, name: original.name, updatedAt: original.updatedAt, lastPage: 1 })
    await new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error) })
    database.close()
    localStorage.setItem('folio:last-document', documentId)
  }, { documentId, bytes: [...bytes] })
  await page.goto('/')
  await expect(page.locator('#page-1 .textLayer')).toContainText('Legacy:')
  await openPanel(page)
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  await expect(panel.locator('.codex-message')).toHaveCount(2)
  await expect(panel.locator('.codex-message.assistant')).toContainText('迁移前保存的回答内容')
  const migrated = await fake.send('继续迁移前的讨论', 0)
  expect(migrated).toMatchObject({ documentId, conversationId: 'legacy', threadId: 'legacy-server-thread' })
  expect(migrated.messages.map((message: Json) => message.role)).toEqual(['user', 'assistant'])
  expect(migrated.messages[1].content).toBe('迁移前保存的回答内容。')
  await fake.finish(0, 'run-migrated', 'legacy-server-thread', '迁移后继续原有会话。')
  await panel.getByRole('button', { name: '新建会话', exact: true }).click()
  const fresh = await fake.send('迁移后新开的独立会话', 1)
  expect(fresh.conversationId).not.toBe('legacy')
  expect(fresh.threadId).toBeUndefined()
  expect(fresh.messages).toEqual([])
  expect(fresh.quote).toBe('')
  await fake.finish(1, 'run-fresh', 'new-server-thread', '新会话保留自己的历史。')
  await switchChat(page, '迁移前的提问')
  await expect(panel.locator('.codex-message')).toHaveCount(4)
  await expect(panel.locator('.codex-message.assistant').last()).toContainText('迁移后继续原有会话')
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(page.locator('#page-1 .textLayer')).toContainText('Legacy:')
  await openPanel(page)
  await expect(panel.locator('.codex-message')).toHaveCount(4)
  await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('新会话保留自己的历史')
})
