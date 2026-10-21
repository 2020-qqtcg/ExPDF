import { expect, test, type Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { mkdir } from 'node:fs/promises'
import { showAnnotations, useFixedZoom, clickFileAction } from './helpers/reader'

type Json = Record<string, any>
interface ResponseCall { runId: string; requestId: string; result: Json }

async function agentStub(page: Page) {
  const responses: ResponseCall[] = []
  const interruptions: Json[] = []
  const legacy: Json[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true, agent: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: { defaultModel: 'agent-test', models: [{ id: 'agent-test', name: 'Agent test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }] } }))
  await page.route('**/api/codex/agent/status*', route => route.fulfill({ json: { available: true, desktopControl: false, workspaceRoot: '/private/folio-test-workspace', capabilities: [{ id: 'pdf', label: '当前 PDF', enabled: true }, { id: 'desktop', label: '桌面控制', enabled: false }], mcpServers: [{ name: 'Test research', status: 'connected', toolCount: 1 }], skills: [{ name: 'research', enabled: true }] } }))
  await page.route('**/api/codex/agent/respond', async route => {
    responses.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } }).catch(() => {})
  })
  await page.route('**/api/codex/agent/interrupt', async route => {
    interruptions.push(route.request().postDataJSON())
    await route.fulfill({ json: { ok: true } }).catch(() => {})
  })
  await page.route('**/api/codex/ask', route => {
    legacy.push(route.request().postDataJSON())
    return route.fulfill({ status: 500, json: { error: 'The agent must not invoke the legacy model endpoint.' } })
  })
  // Only the SSE endpoint is replaced. Its actual reader receives byte chunks,
  // while all tool results and approvals still go through the HTTP client.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    const streams: any[] = []
    ;(window as any).__folioAgentStreams = streams
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url, location.href).pathname !== '/api/codex/agent/run') return original(input, init)
      const item: any = { body: JSON.parse(String(init?.body)), aborted: false }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          item.controller = controller
          init?.signal?.addEventListener('abort', () => {
            item.aborted = true
            try { controller.error(new DOMException('The operation was aborted.', 'AbortError')) } catch { /* Already finished. */ }
          }, { once: true })
        },
        cancel() { item.aborted = true },
      })
      streams.push(item)
      return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    }
  })
  const calls = () => page.evaluate(() => (window as any).__folioAgentStreams.map((item: any) => ({ body: item.body, aborted: item.aborted })))
  const emit = (index: number, event: Json, end = false) => page.evaluate(({ index, event, end }) => {
    const stream = (window as any).__folioAgentStreams[index]
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    try {
      // Include byte boundaries inside Chinese text instead of passing objects
      // directly to the application's event handler.
      for (let offset = 0; offset < bytes.length; offset += 7) stream.controller.enqueue(bytes.slice(offset, offset + 7))
      if (end) stream.controller.close()
      return true
    } catch { return false }
  }, { index, event, end })
  const request = async (index: number, runId: string, requestId: string, tool: string, args: Json) => {
    await emit(index, { type: 'request', runId, requestId, kind: 'tool', params: { threadId: `thread-${index}`, turnId: `turn-${index}`, callId: requestId, namespace: null, tool, arguments: args } })
    await expect.poll(() => responses.find(item => item.runId === runId && item.requestId === requestId)).toBeTruthy()
    return responses.find(item => item.runId === runId && item.requestId === requestId)!
  }
  return { calls, emit, request, responses, interruptions, legacy }
}

async function loadPdf(page: Page, name: string, label: string) {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 2; number++) {
    const sheet = pdf.addPage([612, 792])
    sheet.drawText(`${label} page ${number}: deliberate reading.`, { x: 56, y: 716, size: 18, font })
    sheet.drawText(`Evidence sentinel ${label}-${number}`, { x: 56, y: 678, size: 14, font })
  }
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) })
  await expect(page.locator('#page-1 .textLayer')).toContainText(`${label} page 1`)
  await useFixedZoom(page)
}

async function openAgent(page: Page) {
  await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  await expect(panel.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
  return panel
}

test('streams a multi-step PDF task, returns real document data, and persists undoable notes and highlights', async ({ page }) => {
  const fake = await agentStub(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await loadPdf(page, 'agent-alpha.pdf', 'Alpha')
  const panel = await openAgent(page)
  expect(await fake.calls()).toHaveLength(0)
  await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill('请阅读两页，标出关键文字并添加摘要批注。')
  await panel.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect.poll(async () => (await fake.calls()).length).toBe(1)
  const body = (await fake.calls())[0].body
  expect(body).toMatchObject({ documentName: 'agent-alpha.pdf', page: 1, quote: '', model: 'agent-test', reasoningEffort: 'medium' })
  expect(body.documentId).toEqual(expect.any(String))
  await fake.emit(0, { type: 'thread', runId: 'run-alpha', threadId: 'thread-alpha', workspace: '/private/folio-test-workspace' })
  await fake.emit(0, { type: 'activity', runId: 'run-alpha', item: { id: 'research', kind: 'mcpToolCall', title: '读取并整理 PDF', status: 'inProgress', detail: '正在核对第 1–2 页。' } })
  await fake.emit(0, { type: 'delta', runId: 'run-alpha', text: '正在核对两页内容，' })
  await expect(panel.getByRole('log', { name: '问答记录' })).toContainText('正在核对两页内容')
  const document = await fake.request(0, 'run-alpha', 'document', 'folio_pdf_get_document', {})
  expect(document.result).toMatchObject({ ok: true, documentId: body.documentId, name: 'agent-alpha.pdf', pageCount: 2 })
  const pages = await fake.request(0, 'run-alpha', 'read', 'folio_pdf_read_pages', { startPage: 1, endPage: 2 })
  expect(pages.result.ok).toBe(true)
  expect(pages.result.pages).toHaveLength(2)
  expect(pages.result.pages[0].text).toContain('Evidence sentinel Alpha-1')
  expect(pages.result.pages[1].text).toContain('Evidence sentinel Alpha-2')
  expect((await fake.request(0, 'run-alpha', 'navigate', 'folio_pdf_navigate_page', { page: 2 })).result).toMatchObject({ ok: true, page: 2 })
  await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue('2')
  const highlight = await fake.request(0, 'run-alpha', 'highlight', 'folio_pdf_highlight_text', { page: 2, text: 'deliberate reading.' })
  expect(highlight.result).toMatchObject({ ok: true, kind: 'highlight', page: 2 })
  expect(highlight.result.rects.length).toBeGreaterThan(0)
  expect((await fake.request(0, 'run-alpha', 'note', 'folio_pdf_add_note', { page: 2, comment: '第二页摘要：有意识地阅读，并核对原文证据。' })).result).toMatchObject({ ok: true, kind: 'note', page: 2 })
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await fake.emit(0, { type: 'activity', runId: 'run-alpha', item: { id: 'research', kind: 'mcpToolCall', title: '读取并整理 PDF', status: 'completed', detail: '两页已核对，标注已保存。' } })
  await fake.emit(0, { type: 'complete', runId: 'run-alpha', threadId: 'thread-alpha', status: 'completed', answer: '## 已完成\n\n已核对两页，添加一处高亮与一条摘要批注。' }, true)
  await expect(panel.locator('.codex-message.assistant')).toContainText('已核对两页')
  await expect(panel.getByRole('textbox', { name: '向 Codex 提问' })).toBeEnabled()
  await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('正在核对两页内容')
  expect(fake.legacy).toEqual([])
  await expect(panel.getByLabel('任务执行记录')).toHaveCount(1)
  await panel.getByLabel('任务执行记录').locator('summary').first().click()
  await expect(panel.locator('.codex-work li[data-state="completed"]')).toHaveCount(1)
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/codex-agent-reader.png' })
  await showAnnotations(page)
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await expect(page.locator('.annotation-card').filter({ hasText: 'deliberate reading.' })).toHaveCount(1)
  await expect(page.locator('.annotation-card').filter({ hasText: '第二页摘要' })).toHaveCount(1)
  await clickFileAction(page, '撤销')
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await clickFileAction(page, '重做')
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.reload()
  await expect(page.locator('#page-2 .textLayer')).toContainText('Alpha page 2')
  await showAnnotations(page)
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  const restored = await openAgent(page)
  await expect(restored.locator('.codex-message.assistant')).toContainText('已核对两页')
  await restored.getByRole('textbox', { name: '向 Codex 提问' }).fill('请根据刚才结果继续。')
  await restored.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect.poll(async () => (await fake.calls()).length).toBe(1)
  expect((await fake.calls())[0].body).toMatchObject({ threadId: 'thread-alpha', documentId: body.documentId })
  expect((await fake.calls())[0].body.messages.map((message: Json) => message.role)).toEqual(['user', 'assistant'])
  await fake.emit(0, { type: 'thread', runId: 'run-followup', threadId: 'thread-alpha', workspace: '/private/folio-test-workspace' })
  await fake.emit(0, { type: 'complete', runId: 'run-followup', threadId: 'thread-alpha', status: 'completed', answer: '继续使用同一 PDF 会话。' }, true)
  await expect(restored.locator('.codex-message.assistant').last()).toContainText('继续使用同一 PDF 会话')
})

test('requires a deliberate approval and user-input response, rendering untrusted command text safely', async ({ page }) => {
  const fake = await agentStub(page)
  await page.goto('/')
  await loadPdf(page, 'agent-approval.pdf', 'Approval')
  const panel = await openAgent(page)
  await panel.getByRole('button', { name: '工具与连接', exact: true }).click()
  await expect(panel).toContainText('当前 PDF')
  expect(await fake.calls()).toHaveLength(0)
  await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill('整理摘要，并在必要时向我确认。')
  await panel.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect.poll(async () => (await fake.calls()).length).toBe(1)
  await fake.emit(0, { type: 'thread', runId: 'run-approval', threadId: 'thread-approval', workspace: '/private/folio-test-workspace' })
  await fake.emit(0, { type: 'request', runId: 'run-approval', requestId: 'already-resolved', kind: 'command', params: { command: 'printf already-resolved', reason: '这项请求将在其他连接完成。', availableDecisions: ['cancel'] } })
  const resolved = panel.getByRole('region', { name: '运行命令', exact: true })
  await expect(resolved).toContainText('printf already-resolved')
  await expect(resolved.getByRole('button', { name: '允许一次', exact: true })).toBeDisabled()
  await expect(resolved.getByRole('button', { name: '本次会话允许', exact: true })).toHaveCount(0)
  await fake.emit(0, { type: 'activity', runId: 'run-approval', item: { id: 'already-resolved', kind: 'request', title: '请求已处理', status: 'completed' } })
  await expect(resolved).toHaveCount(0)
  expect(fake.responses).toHaveLength(0)
  const unsafe = '<img src=x onerror="window.__agentUnsafe=true"> printf test'
  await fake.emit(0, { type: 'request', runId: 'run-approval', requestId: 'approve-command', kind: 'command', params: { command: unsafe, cwd: '/private/folio-test-workspace', reason: '准备摘要文件。', availableDecisions: ['accept', 'acceptForSession', 'decline'] } })
  await expect(panel).toContainText(unsafe)
  await expect(panel.locator('img, script, iframe')).toHaveCount(0)
  expect(fake.responses).toHaveLength(0)
  await panel.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect.poll(() => fake.responses.length).toBe(1)
  expect(fake.responses[0]).toMatchObject({ runId: 'run-approval', requestId: 'approve-command', result: { decision: 'accept' } })
  await fake.emit(0, { type: 'request', runId: 'run-approval', requestId: 'approve-file', kind: 'fileChange', params: { reason: '覆盖不需要修改的源文件。' } })
  await panel.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect.poll(() => fake.responses.length).toBe(2)
  expect(fake.responses[1].result).toEqual({ decision: 'decline' })
  await fake.emit(0, { type: 'request', runId: 'run-approval', requestId: 'choose-format', kind: 'userInput', params: { isBlocking: true, questions: [{ id: 'format', header: '摘要格式', question: '请填写摘要需要的格式。', isOther: true, isSecret: false, options: [{ label: '要点', description: '简短列表' }, { label: '段落', description: '连续文字' }] }] } })
  await expect(panel.getByRole('textbox', { name: '摘要格式', exact: true })).toBeVisible()
  await panel.getByRole('textbox', { name: '摘要格式', exact: true }).fill('三条中文要点')
  await panel.getByRole('button', { name: '继续', exact: true }).click()
  await expect.poll(() => fake.responses.length).toBe(3)
  expect(fake.responses[2]).toMatchObject({ requestId: 'choose-format', result: { answers: { format: { answers: ['三条中文要点'] } } } })
  await fake.emit(0, { type: 'request', runId: 'run-approval', requestId: 'network-permission', kind: 'permissions', params: { permissions: { network: { enabled: true } }, reason: '访问论文数据库。' } })
  await panel.getByRole('button', { name: '允许一次', exact: true }).click()
  await expect.poll(() => fake.responses.length).toBe(4)
  expect(fake.responses[3]).toMatchObject({ requestId: 'network-permission', result: { permissions: { network: { enabled: true } }, scope: 'turn' } })
  await fake.emit(0, { type: 'request', runId: 'run-approval', requestId: 'service-input', kind: 'elicitation', params: { serverName: 'test-research', message: '给摘要命名并选择需要的内容。', url: 'javascript:window.__agentUnsafe=true', requestedSchema: { type: 'object', properties: {
    title: { type: 'string', title: '摘要标题' },
    format: { type: 'string', title: '输出格式', oneOf: [{ const: 'bullets', title: '中文要点' }, { const: 'paragraphs', title: '连续段落' }] },
    sections: { type: 'array', title: '摘要章节', items: { type: 'string', oneOf: [{ const: 'context', title: '研究背景' }, { const: 'claims', title: '主要论点' }] } },
    pages: { type: 'array', title: '引用页码', items: { type: 'integer' } },
    metadata: { type: 'object', title: '附加信息' },
    optionalComment: { type: 'string', title: '可选备注' },
  }, required: ['title', 'format', 'sections', 'pages'] } } })
  await panel.getByRole('textbox', { name: '摘要标题', exact: true }).fill('中文阅读摘要')
  await panel.getByRole('combobox', { name: '输出格式', exact: true }).selectOption({ label: '中文要点' })
  await panel.getByRole('checkbox', { name: '研究背景', exact: true }).check()
  await panel.getByRole('checkbox', { name: '主要论点', exact: true }).check()
  await panel.getByRole('checkbox', { name: '研究背景', exact: true }).uncheck()
  await panel.getByRole('textbox', { name: '引用页码', exact: true }).fill('[1, invalid]')
  await panel.getByRole('textbox', { name: '附加信息', exact: true }).fill('{"source":"PDF","verified":true}')
  await expect(panel.locator('a[href^="javascript:"]')).toHaveCount(0)
  await panel.getByRole('button', { name: '已完成，继续', exact: true }).click()
  await expect(panel.getByRole('alert')).toContainText('请检查 JSON 格式')
  expect(fake.responses).toHaveLength(4)
  await panel.getByRole('textbox', { name: '引用页码', exact: true }).fill('[1, 2]')
  await panel.getByRole('button', { name: '已完成，继续', exact: true }).click()
  await expect.poll(() => fake.responses.length).toBe(5)
  expect(fake.responses[4]).toMatchObject({ requestId: 'service-input' })
  expect(fake.responses[4].result).toEqual({ action: 'accept', content: { title: '中文阅读摘要', format: 'bullets', sections: ['claims'], pages: [1, 2], metadata: { source: 'PDF', verified: true } } })
  await fake.emit(0, { type: 'complete', runId: 'run-approval', threadId: 'thread-approval', status: 'completed', answer: '已尊重拒绝的文件修改，并按三条要点整理。\n\n<script>window.__agentUnsafe=true</script>\n\n[unsafe](javascript:alert(1))' }, true)
  await expect(panel.locator('.codex-message.assistant')).toContainText('已尊重拒绝的文件修改')
  await expect(panel.locator('a[href^="javascript:"], img, script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as any).__agentUnsafe)).toBeUndefined()
  expect(fake.legacy).toEqual([])
})

test('stops an agent turn and cancels authority over a PDF when the reader opens another document', async ({ page }) => {
  const fake = await agentStub(page)
  await page.goto('/')
  await loadPdf(page, 'agent-first.pdf', 'First')
  let panel = await openAgent(page)
  const send = async (question: string) => {
    await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill(question)
    await panel.getByRole('button', { name: '发送问题', exact: true }).click()
  }
  await send('等待停止的任务')
  await expect.poll(async () => (await fake.calls()).length).toBe(1)
  await fake.emit(0, { type: 'thread', runId: 'run-stop', threadId: 'thread-first', workspace: '/private/folio-test-workspace' })
  await fake.emit(0, { type: 'delta', runId: 'run-stop', text: '正在处理第一份 PDF。' })
  await panel.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect.poll(async () => (await fake.calls())[0].aborted).toBe(true)
  await expect(panel.getByRole('textbox', { name: '向 Codex 提问' })).toBeEnabled()
  await expect.poll(() => fake.interruptions.some(call => call.runId === 'run-stop')).toBe(true)
  expect(await fake.emit(0, { type: 'complete', runId: 'run-stop', status: 'completed', answer: '停止后的迟到回答' }, true)).toBe(false)
  await send('切换文档前仍进行中的任务')
  await expect.poll(async () => (await fake.calls()).length).toBe(2)
  await fake.emit(1, { type: 'thread', runId: 'run-switch', threadId: 'thread-first', workspace: '/private/folio-test-workspace' })
  await loadPdf(page, 'agent-second.pdf', 'Second')
  await expect.poll(async () => (await fake.calls())[1].aborted).toBe(true)
  expect(await fake.emit(1, { type: 'request', runId: 'run-switch', requestId: 'late-note', kind: 'tool', params: { tool: 'folio_pdf_add_note', arguments: { page: 1, comment: '不应进入第二份 PDF 的迟到批注' } } })).toBe(false)
  panel = await openAgent(page)
  await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('第一份 PDF')
  await send('第二份 PDF 的独立任务')
  await expect.poll(async () => (await fake.calls()).length).toBe(3)
  const calls = await fake.calls()
  expect(calls[2].body.documentName).toBe('agent-second.pdf')
  expect(calls[2].body.documentId).not.toBe(calls[0].body.documentId)
  expect(calls[2].body.messages).toEqual([])
  expect(calls[2].body.threadId).toBeUndefined()
  await fake.emit(2, { type: 'thread', runId: 'run-second', threadId: 'thread-second', workspace: '/private/folio-test-workspace' })
  expect((await fake.request(2, 'run-second', 'valid-note', 'folio_pdf_add_note', { page: 1, comment: '只属于第二份 PDF 的批注' })).result).toMatchObject({ ok: true })
  await fake.emit(2, { type: 'complete', runId: 'run-second', threadId: 'thread-second', status: 'completed', answer: '第二份 PDF 已完成。' }, true)
  await expect(panel.locator('.codex-message.assistant')).toContainText('第二份 PDF 已完成')
  expect(fake.responses.some(response => response.requestId === 'late-note')).toBe(false)
  await showAnnotations(page)
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toContainText('只属于第二份 PDF')
  expect(fake.legacy).toEqual([])
})
