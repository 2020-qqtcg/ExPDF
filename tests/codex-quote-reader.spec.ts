import { test, expect, type Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { selectTool, useFixedZoom } from './helpers/reader'

type Json = Record<string, any>
const firstQuote = 'First evidence: deliberate reading requires careful checking.'
const secondQuote = 'Second evidence: conclusions depend on explicit assumptions.'
const panelFor = (page: Page) => page.getByRole('complementary', { name: 'Codex 问答' })

async function stubCodex(page: Page, agent = false) {
  const requests: Json[] = [], interruptions: Json[] = []
  const releases = new Map<number, (value: { status?: number; answer?: string; error?: string }) => void>()
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true, ...(agent ? { agent: true } : {}) } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: { defaultModel: 'quote-test', models: [{ id: 'quote-test', name: 'Quote test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }] } }))
  await page.route('**/api/codex/agent/status*', route => route.fulfill({ json: { available: true, desktopControl: false, capabilities: [], mcpServers: [], skills: [] } }))
  await page.route('**/api/codex/agent/interrupt', route => { interruptions.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/codex/ask', async route => {
    if (agent) { await route.fulfill({ status: 500, json: { error: 'Unexpected legacy request.' } }); return }
    const index = requests.push(route.request().postDataJSON()) - 1
    const result = await new Promise<{ status?: number; answer?: string; error?: string }>(resolve => releases.set(index, resolve))
    await route.fulfill({ status: result.status ?? 200, json: result }).catch(() => {})
  })
  if (agent) await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    const streams: any[] = []
    ;(window as any).__quoteTestStreams = streams
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (new URL(url, location.href).pathname !== '/api/codex/agent/run') return original(input, init)
      const item: any = { body: JSON.parse(String(init?.body)), aborted: false }
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        item.controller = controller
        init?.signal?.addEventListener('abort', () => { item.aborted = true; try { controller.error(new DOMException('Aborted', 'AbortError')) } catch { /* Already ended. */ } }, { once: true })
      }, cancel() { item.aborted = true } })
      streams.push(item)
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
    }
  })
  const calls = async (): Promise<Json[]> => agent ? page.evaluate(() => (window as any).__quoteTestStreams.map((item: any) => item.body)) : requests
  const emit = (index: number, event: Json, close = false) => page.evaluate(({ index, event, close }) => {
    const item = (window as any).__quoteTestStreams[index]
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
    for (let offset = 0; offset < bytes.length; offset += 7) item.controller.enqueue(bytes.slice(offset, offset + 7))
    if (close) item.controller.close()
  }, { index, event, close })
  const send = async (question: string, index: number) => {
    await panelFor(page).getByRole('textbox', { name: '向 Codex 提问' }).fill(question)
    await panelFor(page).getByRole('button', { name: '发送问题', exact: true }).click()
    await expect.poll(async () => (await calls()).length).toBe(index + 1)
    return (await calls())[index]
  }
  const answer = async (index: number, content: string) => {
    if (agent) await emit(index, { type: 'complete', runId: `quote-run-${index}`, threadId: 'quote-thread', status: 'completed', answer: content }, true)
    else releases.get(index)!({ answer: content })
    await expect(panelFor(page).locator('.codex-message.assistant').last()).toContainText(content)
    await expect(panelFor(page).getByRole('textbox', { name: '向 Codex 提问' })).toBeEnabled()
  }
  return { calls, send, answer, emit, interruptions, releases }
}

async function openFixture(page: Page) {
  await page.goto('/')
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica)
  const sheet = pdf.addPage([612, 792])
  sheet.drawText(firstQuote, { x: 46, y: 710, size: 16, font })
  sheet.drawText(secondQuote, { x: 46, y: 660, size: 16, font })
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'quote-consumption.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) })
  await expect(page.locator('#page-1 .textLayer')).toContainText(firstQuote)
  await useFixedZoom(page)
}

async function quoteFromPage(page: Page, quote: string) {
  await selectTool(page, '选择文本')
  await page.locator('#page-1 .textLayer span').filter({ hasText: quote }).first().evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges(); window.getSelection()?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('toolbar', { name: '选中文字工具', exact: true }).getByRole('button', { name: '问 Codex', exact: true }).click()
  await expect(panelFor(page).locator('.codex-source blockquote')).toHaveText(quote)
  await expect(panelFor(page).getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
}

async function expectConsumed(page: Page) {
  await expect(panelFor(page).locator('.codex-source')).toHaveCount(0, { timeout: 2_000 })
  for (const name of ['解释这段', '翻译成中文', '概括要点']) await expect(panelFor(page).getByRole('button', { name, exact: true })).toHaveCount(0)
}

test('consumes a legacy excerpt immediately after a valid send, preserves its completed history, and requires a fresh selection for another quoted question', async ({ page }) => {
  const fake = await stubCodex(page)
  await openFixture(page)
  await quoteFromPage(page, firstQuote)
  const input = panelFor(page).getByRole('textbox', { name: '向 Codex 提问' })
  await input.fill('   ')
  await expect(panelFor(page).getByRole('button', { name: '发送问题', exact: true })).toBeDisabled()
  await input.press('Control+Enter')
  expect(await fake.calls()).toHaveLength(0)
  await expect(panelFor(page).locator('.codex-source blockquote')).toHaveText(firstQuote)
  const first = await fake.send('解释第一条证据。', 0)
  expect(first.quote).toBe(firstQuote)
  await expectConsumed(page)
  await expect(input).toBeDisabled()
  await expect(panelFor(page).getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await expect(panelFor(page).locator('.codex-message.user .codex-message-quote blockquote')).toHaveText(firstQuote)
  await fake.answer(0, '第一条证据需要结合原文检查。')
  await expect(panelFor(page).locator('.codex-message.user .codex-message-quote blockquote')).toHaveText(firstQuote)
  await panelFor(page).getByRole('button', { name: '关闭 Codex 侧栏', exact: true }).click()
  await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  await expectConsumed(page)
  const followUp = await fake.send('现在直接谈谈一般阅读方法。', 1)
  expect(followUp.quote).toBe('')
  expect(followUp.messages[0].content).toContain(firstQuote)
  await fake.answer(1, '普通追问不重新引用之前的段落。')
  await quoteFromPage(page, secondQuote)
  const selectedAgain = await fake.send('解释新选中的第二条证据。', 2)
  expect(selectedAgain.quote).toBe(secondQuote)
  await expectConsumed(page)
  await fake.answer(2, '第二条证据说明结论依赖明确的假设。')
  await expect(panelFor(page).locator('.codex-message.user .codex-message-quote blockquote')).toHaveText([firstQuote, secondQuote])
})

test('consumes an SSE agent excerpt without interrupting its live stream or erasing the quoted user history', async ({ page }) => {
  const fake = await stubCodex(page, true)
  await openFixture(page)
  await quoteFromPage(page, firstQuote)
  const first = await fake.send('请流式解释这条证据。', 0)
  expect(first.quote).toBe(firstQuote)
  await expectConsumed(page)
  await fake.emit(0, { type: 'thread', runId: 'quote-run-0', threadId: 'quote-thread', workspace: '/private/test-quote' })
  await fake.emit(0, { type: 'delta', text: '正在结合引用原文核对。' })
  await expect(panelFor(page).getByRole('log', { name: '问答记录' })).toContainText('正在结合引用原文核对')
  await expect(panelFor(page).locator('.codex-message.user .codex-message-quote blockquote')).toHaveText(firstQuote)
  expect(await page.evaluate(() => (window as any).__quoteTestStreams[0].aborted)).toBe(false)
  expect(fake.interruptions).toEqual([])
  await fake.answer(0, '代理已保留本次引用，并完成解释。')
  await expect(panelFor(page).locator('.codex-message.user .codex-message-quote blockquote')).toHaveText(firstQuote)
  const next = await fake.send('接下来不引用段落，继续说明。', 1)
  expect(next.quote).toBe('')
  expect(next.threadId).toBe('quote-thread')
  expect(next.messages[0].content).toContain(firstQuote)
  await fake.emit(1, { type: 'thread', runId: 'quote-run-1', threadId: 'quote-thread', workspace: '/private/test-quote' })
  await fake.answer(1, '新一问只携带历史中的引用。')
})

test('does not silently restore an already sent excerpt after an agent error or reuse it when retrying', async ({ page }) => {
  const fake = await stubCodex(page, true)
  await openFixture(page)
  await quoteFromPage(page, firstQuote)
  expect((await fake.send('这次请求将模拟失败。', 0)).quote).toBe(firstQuote)
  await expectConsumed(page)
  await fake.emit(0, { type: 'thread', runId: 'quote-run-0', threadId: 'quote-thread', workspace: '/private/test-quote' })
  await fake.emit(0, { type: 'error', message: '模拟服务暂时失败，请重试。' }, true)
  await expect(panelFor(page).getByRole('alert')).toContainText('模拟服务暂时失败')
  await expectConsumed(page)
  const retry = await fake.send('这次请求将模拟失败。', 1)
  expect(retry.quote).toBe('')
  expect(retry.messages).toEqual([])
  await fake.emit(1, { type: 'thread', runId: 'quote-run-1', threadId: 'quote-thread', workspace: '/private/test-quote' })
  await fake.answer(1, '重试成功，没有复用已经消费的摘录。')
  await expect(panelFor(page).locator('.codex-message-quote')).toHaveCount(0)
})
