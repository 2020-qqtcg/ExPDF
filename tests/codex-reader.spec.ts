import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { selectTool, showAnnotations, useFixedZoom } from './helpers/reader'

interface AskRequest {
  documentName: string
  page: number
  quote: string
  pageText: string
  question: string
  messages: { role: string; content: string }[]
}
interface Reply { status?: number; answer?: string; error?: string; abort?: boolean }

async function mockCodex(page: Page, reply: (body: AskRequest, index: number) => Reply | Promise<Reply>) {
  const calls: AskRequest[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: {
    defaultModel: 'reader-test-model',
    models: [{ id: 'reader-test-model', name: 'Reader test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }],
  } }))
  // Every model request is intercepted: these tests never invoke the local CLI.
  await page.route('**/api/codex/ask', async route => {
    const body = route.request().postDataJSON() as AskRequest
    calls.push(body)
    const response = await reply(body, calls.length - 1)
    if (response.abort) { await route.abort('failed').catch(() => {}); return }
    await route.fulfill({ status: response.status ?? 200, json: { answer: response.answer, error: response.error } }).catch(() => {})
  })
  return calls
}

const quoteFor = (label: string, pageNumber = 1) => `${label}: selected passage on page ${pageNumber}`

async function loadFixture(page: Page, name: string, label: string) {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let pageNumber = 1; pageNumber <= 2; pageNumber++) {
    const sheet = document.addPage([612, 792])
    sheet.drawText(quoteFor(label, pageNumber), { x: 56, y: 720, size: 18, font })
    sheet.drawText(`Context sentinel for page ${pageNumber}`, { x: 56, y: 680, size: 14, font })
    sheet.drawText('A second paragraph supplies context for this paper.', { x: 56, y: 650, size: 14, font })
  }
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(await document.save()) })
  await expect(page.locator('#page-1 .textLayer')).toContainText(quoteFor(label))
  await useFixedZoom(page)
}

async function openFixture(page: Page, name = 'codex-paper.pdf', label = 'Codex paper') {
  await page.goto('/')
  await expect(page.locator('#page-1 canvas')).toBeVisible()
  await loadFixture(page, name, label)
}

async function selectQuote(page: Page, label: string, pageNumber = 1, tool: '选择文本' | '下划线' = '选择文本') {
  await selectTool(page, tool)
  const text = page.locator(`#page-${pageNumber} .textLayer span`).filter({ hasText: quoteFor(label, pageNumber) }).first()
  await expect(text).toBeVisible()
  await text.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
}

async function askSelection(page: Page, label: string, pageNumber = 1) {
  await selectQuote(page, label, pageNumber)
  await page.getByRole('toolbar', { name: '选中文字工具', exact: true }).getByRole('button', { name: '问 Codex', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Codex 问答' })).toBeVisible()
}

async function showSavedConversation(page: Page) {
  if (!await page.getByRole('complementary', { name: 'Codex 问答' }).isVisible()) {
    await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  }
  await expect(page.getByRole('complementary', { name: 'Codex 问答' })).toBeVisible()
}

test('passes a selected passage and its page context only after send, and safely renders a Markdown reply', async ({ page }) => {
  const imageRequests: string[] = []
  page.on('request', request => { if (request.url().includes('codex-test-image.png')) imageRequests.push(request.url()) })
  const answer = '## 这段话的含义\n\n这里解释选中的论述，并结合当前页理解它。\n\n- **核心概念**：先明确条件，再检查结论。\n- **阅读建议**：结合上下文核对推理。\n\n<img src="x" onerror="window.__codexUnsafe=true">\n<script>window.__codexUnsafe=true</script>\n\n![外部图片](https://example.invalid/codex-test-image.png)\n\n[不安全链接](javascript:alert(1))'
  const calls = await mockCodex(page, () => ({ answer }))
  await openFixture(page, 'codex-selection.pdf', 'Selection paper')
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.locator('#page-2')).toBeInViewport({ ratio: 0.75 })
  await askSelection(page, 'Selection paper', 2)
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  await expect(panel.locator('.codex-source blockquote')).toHaveText(quoteFor('Selection paper', 2))
  await expect(panel.locator('.codex-source')).toContainText('第 2 页摘录')
  await expect(panel.getByRole('button', { name: '解释这段', exact: true })).toBeEnabled()
  expect(calls).toHaveLength(0)
  const question = '请解释这段论述成立的条件。'
  await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill(question)
  await panel.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(panel.locator('.codex-message.assistant')).toContainText('这里解释选中的论述')
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ documentName: 'codex-selection.pdf', page: 2, quote: quoteFor('Selection paper', 2), question, messages: [] })
  expect(calls[0].pageText).toContain('Context sentinel for page 2')
  expect(calls[0].pageText).not.toContain('Context sentinel for page 1')
  await expect(panel.getByRole('heading', { name: '这段话的含义' })).toBeVisible()
  await expect(panel.locator('img, script, iframe')).toHaveCount(0)
  await expect(panel.locator('a[href^="javascript:"]')).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__codexUnsafe)).toBeUndefined()
  expect(imageRequests).toEqual([])
})

test('opens Codex from saved underline markup and supports all quick questions without opening the annotation editor', async ({ page }) => {
  const calls = await mockCodex(page, (_body, index) => ({ answer: `## 快捷回答 ${index + 1}\n\n这段论述可以从**条件与结论**两个角度理解。\n\n- 先明确作者提出的前提。\n- 再结合当前页核对推理过程。` }))
  await openFixture(page)
  await showAnnotations(page)
  await selectQuote(page, 'Codex paper', 1, '下划线')
  const card = page.locator('.annotation-card').filter({ hasText: quoteFor('Codex paper') })
  await expect(card).toHaveCount(1)
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
  await card.getByRole('button', { name: '向 Codex 提问这条标注', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  await expect(panel.locator('.codex-source blockquote')).toHaveText(quoteFor('Codex paper'))
  await expect(page.getByRole('textbox', { name: '标注内容' })).not.toBeVisible()
  await expect(panel.getByRole('button', { name: '解释这段', exact: true })).toBeEnabled()
  expect(calls).toHaveLength(0)
  for (const [index, [label, word]] of [['解释这段', '解释'], ['翻译成中文', '翻译'], ['概括要点', '概括']].entries()) {
    if (index > 0) {
      await panel.getByRole('button', { name: '返回标注', exact: true }).click()
      await card.getByRole('button', { name: '向 Codex 提问这条标注', exact: true }).click()
      await expect(panel.locator('.codex-source blockquote')).toHaveText(quoteFor('Codex paper'))
    }
    await panel.getByRole('button', { name: label, exact: true }).click()
    await expect(panel.locator('.codex-source, .codex-prompts')).toHaveCount(0)
    await expect(panel.locator('.codex-message.assistant').last()).toContainText(`快捷回答 ${index + 1}`)
    expect(calls[index].question).toContain(word)
    expect(calls[index].quote).toBe(quoteFor('Codex paper'))
    expect(calls[index].pageText).toContain('Context sentinel for page 1')
    if (index === 0) {
      await mkdir('tmp', { recursive: true })
      await page.screenshot({ path: 'tmp/codex-reader.png' })
    }
  }
  await panel.getByRole('button', { name: '返回标注', exact: true }).click()
  await expect(card).toBeVisible()
  await expect(page.locator('.pdf-mark-outline')).toHaveCount(0)
})

test('includes prior answers in follow-up requests and isolates persistent conversations by PDF', async ({ page }) => {
  const calls = await mockCodex(page, body => ({ answer: body.question === 'A 的第一问' ? 'A 的回答一' : body.question === 'A 的追问' ? 'A 的回答二' : body.question === 'A 的恢复后追问' ? 'A 的回答三' : 'B 的独立回答' }))
  await openFixture(page, 'codex-alpha.pdf', 'Alpha paper')
  await askSelection(page, 'Alpha paper')
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  for (const [question, answer] of [['A 的第一问', 'A 的回答一'], ['A 的追问', 'A 的回答二']]) {
    await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill(question)
    await panel.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(panel.locator('.codex-message.assistant').last()).toHaveText(new RegExp(answer))
  }
  expect(calls[1].messages.map(message => message.role)).toEqual(['user', 'assistant'])
  expect(calls[1].messages[0].content).toContain('A 的第一问')
  expect(calls[1].messages[0].content).toContain(quoteFor('Alpha paper'))
  expect(calls[1].messages[1].content).toBe('A 的回答一')
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await loadFixture(page, 'codex-beta.pdf', 'Beta paper')
  await askSelection(page, 'Beta paper')
  await expect(panel.locator('.codex-message')).toHaveCount(0)
  await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill('B 的第一问')
  await panel.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(panel.locator('.codex-message.assistant')).toContainText('B 的独立回答')
  expect(calls[2].messages).toEqual([])
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await page.getByRole('button', { name: '最近阅读', exact: true }).click()
  await page.getByRole('button', { name: '打开历史 PDF：codex-alpha.pdf', exact: true }).click()
  await expect(page.locator('#page-1 .textLayer')).toContainText(quoteFor('Alpha paper'))
  await showSavedConversation(page)
  await expect(panel.locator('.codex-message.assistant')).toHaveCount(2)
  await expect(panel.getByRole('log', { name: '问答记录' })).toContainText('A 的回答一')
  await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('B 的独立回答')
  await page.reload()
  await expect(page.locator('#page-1 .textLayer')).toContainText(quoteFor('Alpha paper'))
  await showSavedConversation(page)
  await expect(panel.locator('.codex-message.user')).toHaveCount(2)
  await expect(panel.locator('.codex-message.assistant')).toHaveCount(2)
  await expect(panel.locator('.codex-source, .codex-prompts')).toHaveCount(0)
  expect(calls).toHaveLength(3)
  await panel.getByRole('textbox', { name: '向 Codex 提问' }).fill('A 的恢复后追问')
  await panel.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(panel.locator('.codex-message.assistant').last()).toContainText('A 的回答三')
  expect(calls[3]).toMatchObject({ question: 'A 的恢复后追问', quote: '' })
  expect(calls[3].messages).toHaveLength(4)
  expect(calls[3].messages[0].content).toContain(quoteFor('Alpha paper'))
})

test('stops pending requests, ignores late answers, and recovers after a server error', async ({ page }) => {
  let release = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  const calls = await mockCodex(page, async (_body, index) => {
    if (index === 0) { await pending; return { answer: '这条迟到的回答不应出现。' } }
    if (index === 1) return { status: 503, error: '测试连接失败，请重试。' }
    return { answer: '重试后的正常回答。' }
  })
  try {
    await openFixture(page)
    await askSelection(page, 'Codex paper')
    const panel = page.getByRole('complementary', { name: 'Codex 问答' })
    const input = panel.getByRole('textbox', { name: '向 Codex 提问' })
    await input.fill('等待中的问题')
    await panel.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect.poll(() => calls.length).toBe(1)
    await panel.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('已停止生成')
    await expect(input).toBeEnabled()
    release()
    await input.fill('触发测试错误')
    await panel.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(panel.getByRole('alert')).toHaveText('测试连接失败，请重试。')
    await expect(panel.locator('.codex-message.assistant')).toHaveCount(0)
    await input.fill('重新提问')
    await panel.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(panel.locator('.codex-message.assistant')).toHaveText(new RegExp('重试后的正常回答'))
    await expect(panel.getByRole('log', { name: '问答记录' })).not.toContainText('迟到的回答')
    expect(calls).toHaveLength(3)
    expect(calls[2].messages).toEqual([])
  } finally { release() }
})

test('asks directly about the current page without a selection and preserves unquoted follow-up history after reloading', async ({ page }) => {
  const firstQuestion = '请概括当前第二页的内容。'
  const followUp = '接着说明这页最重要的条件。'
  const firstAnswer = '第二页讨论了阅读当前上下文时需要核对的条件。'
  const secondAnswer = '继续核对条件，并将它们与当前页的论述联系起来。'
  const calls = await mockCodex(page, (_body, index) => ({ answer: index === 0 ? firstAnswer : secondAnswer }))
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openFixture(page, 'codex-direct.pdf', 'Direct paper')
  await page.getByRole('button', { name: '下一页', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue('2')
  await expect(page.locator('#page-2 .textLayer')).toContainText('Context sentinel for page 2')
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('')
  await showSavedConversation(page)
  const panel = page.getByRole('complementary', { name: 'Codex 问答', exact: true })
  const input = panel.getByRole('textbox', { name: '向 Codex 提问', exact: true })
  const send = panel.getByRole('button', { name: '发送问题', exact: true })
  await expect(input).toBeEnabled()
  await expect(send).toBeDisabled()
  await expect(panel.locator('.codex-source blockquote')).toHaveCount(0)
  await input.fill('  \n  ')
  await expect(send).toBeDisabled()
  await input.press('Control+Enter')
  expect(calls).toEqual([])

  await input.fill(firstQuestion)
  await expect(send).toBeEnabled()
  await send.click()
  await expect(panel.locator('.codex-message.assistant')).toHaveText(new RegExp(firstAnswer))
  expect(calls).toHaveLength(1)
  expect(calls[0]).toMatchObject({ documentName: 'codex-direct.pdf', page: 2, quote: '', question: firstQuestion, messages: [] })
  expect(calls[0].pageText).toContain('Context sentinel for page 2')
  expect(calls[0].pageText).not.toContain('Context sentinel for page 1')
  await input.fill(followUp)
  await send.click()
  await expect(panel.locator('.codex-message.assistant').last()).toHaveText(new RegExp(secondAnswer))
  expect(calls).toHaveLength(2)
  expect(calls[1]).toMatchObject({ page: 2, quote: '', question: followUp, messages: [
    { role: 'user', content: firstQuestion }, { role: 'assistant', content: firstAnswer },
  ] })
  await expect(panel.locator('.codex-message-quote')).toHaveCount(0)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/codex-direct-question.png' })
  await page.reload()
  await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue('2')
  await showSavedConversation(page)
  await expect(panel.locator('.codex-message.assistant')).toHaveCount(2)
  await expect(input).toBeEnabled()
  await expect(panel.locator('.codex-source blockquote, .codex-message-quote')).toHaveCount(0)
})

test('restores an unquoted direct question after stopping or a network failure and retries without failed history', async ({ page }) => {
  let release = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  const question = '直接解释第二页的论述。'
  const calls = await mockCodex(page, async (_body, index) => {
    if (index === 0) { await pending; return { answer: '取消后迟到的直接回答。' } }
    if (index === 1) return { abort: true }
    return { answer: '直接问题已重试成功。' }
  })
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await openFixture(page, 'codex-direct-retry.pdf', 'Direct retry paper')
    await page.getByRole('button', { name: '下一页', exact: true }).click()
    await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue('2')
    await showSavedConversation(page)
    const panel = page.getByRole('complementary', { name: 'Codex 问答', exact: true })
    const input = panel.getByRole('textbox', { name: '向 Codex 提问', exact: true })
    const send = panel.getByRole('button', { name: '发送问题', exact: true })
    await input.fill(question)
    await send.click()
    await expect.poll(() => calls.length).toBe(1)
    await expect(input).toBeDisabled()
    await panel.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(panel.getByRole('alert')).toContainText('已停止生成')
    await expect(input).toBeEnabled()
    await expect(input).toHaveValue(question)
    release()
    await send.click()
    await expect.poll(() => calls.length).toBe(2)
    await expect(panel.getByRole('alert')).toBeVisible()
    await expect(input).toBeEnabled()
    await expect(input).toHaveValue(question)
    await expect(panel.locator('.codex-message')).toHaveCount(0)
    await send.click()
    await expect(panel.locator('.codex-message.assistant')).toContainText('直接问题已重试成功')
    await expect(panel.getByRole('log', { name: '问答记录', exact: true })).not.toContainText('迟到的直接回答')
    expect(calls).toHaveLength(3)
    for (const call of calls) {
      expect(call).toMatchObject({ page: 2, quote: '', question, messages: [] })
      expect(call.pageText).toContain('Context sentinel for page 2')
    }
  } finally { release() }
})
