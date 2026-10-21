import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { chooseCodexOption } from './helpers/codex'
import { selectTool } from './helpers/reader'

const catalog = {
  defaultModel: 'rich-research',
  models: [
    { id: 'rich-research', name: 'Research model', description: 'For careful reading.', reasoningLevels: [{ id: 'medium', label: '标准' }, { id: 'ultra', label: '最深入' }], defaultReasoningLevel: 'medium' },
    { id: 'rich-focused', name: 'Focused model', reasoningLevels: [{ id: 'medium', label: '标准' }, { id: 'high', label: '深入' }], defaultReasoningLevel: 'medium' },
    { id: 'rich-auto', name: 'Automatic model', reasoningLevels: [], defaultReasoningLevel: '' },
  ],
}
interface Ask { question: string; quote: string; model?: string; reasoningEffort?: string }

async function stubCodex(page: Page, answer: string | (() => Promise<string>)) {
  const calls: Ask[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: catalog }))
  await page.route('**/api/codex/ask', async route => {
    calls.push(route.request().postDataJSON() as Ask)
    await route.fulfill({ json: { answer: typeof answer === 'string' ? answer : await answer() } }).catch(() => {})
  })
  return calls
}

async function openQuotedAssistant(page: Page, navigate = true) {
  if (navigate) await page.goto('/')
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  await selectTool(page, '选择文本')
  await page.locator('#page-1 .textLayer span').first().evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('toolbar', { name: '选中文字工具', exact: true }).getByRole('button', { name: '问 Codex', exact: true }).click()
  await expect(page.getByRole('complementary', { name: 'Codex 问答' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
  await expectComposerSettings(page)
}

async function expectComposerSettings(page: Page) {
  const form = page.locator('.codex-compose form')
  const textarea = await form.getByRole('textbox', { name: '向 Codex 提问', exact: true }).boundingBox()
  const send = await form.getByRole('button', { name: '发送问题', exact: true }).boundingBox()
  expect(textarea).not.toBeNull()
  expect(send).not.toBeNull()
  for (const label of ['Codex 模型', '思考深度']) {
    const trigger = form.getByRole('combobox', { name: label, exact: true })
    await expect(trigger).toBeInViewport({ ratio: 1 })
    const box = await trigger.boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(textarea!.y + textarea!.height)
    expect(box!.x + box!.width).toBeLessThanOrEqual(send!.x)
    expect(box!.height).toBeCloseTo(28, 0)
    await trigger.click()
    const list = page.getByRole('listbox', { name: label, exact: true })
    await expect(list).toBeInViewport({ ratio: 1 })
    const popup = await list.locator('..').boundingBox()
    expect(popup!.y + popup!.height).toBeLessThanOrEqual(box!.y)
    await trigger.press('Escape')
    await expect(list).toHaveCount(0)
  }
  const refresh = form.getByRole('button', { name: '刷新 Codex 模型', exact: true })
  await expect(refresh).toHaveAttribute('type', 'button')
  const refreshBox = await refresh.boundingBox()
  expect(refreshBox!.y).toBeGreaterThanOrEqual(textarea!.y + textarea!.height)
  expect(refreshBox!.x + refreshBox!.width).toBeLessThanOrEqual(send!.x)
}

async function expectActive(trigger: Locator, option: Locator) {
  const id = await option.getAttribute('id')
  expect(id).toBeTruthy()
  await expect(trigger).toHaveAttribute('aria-activedescendant', id!)
}

test('operates model pickers with the keyboard, cancels drafts, preserves external focus, and remembers effort while generating', async ({ page }) => {
  let release = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  const calls = await stubCodex(page, async () => { await pending; return '已按键盘选择的设置回答。' })
  try {
    await openQuotedAssistant(page)
    const model = page.getByRole('combobox', { name: 'Codex 模型', exact: true })
    const effort = page.getByRole('combobox', { name: '思考深度', exact: true })
    const models = page.getByRole('listbox', { name: 'Codex 模型', exact: true })
    const efforts = page.getByRole('listbox', { name: '思考深度', exact: true })
    await expect(model).toContainText('Research model')
    await expect(page.locator('.codex-panel select')).toHaveCount(0)
    await model.press('End')
    await expect(model).toHaveAttribute('aria-expanded', 'true')
    await expectActive(model, models.getByRole('option', { name: 'Automatic model', exact: true }))
    await expect(models.getByRole('option', { name: 'Research model', exact: true })).toHaveAttribute('aria-selected', 'true')
    await model.press('Escape')
    await expect(models).toHaveCount(0)
    await expect(model).toBeFocused()
    await expect(model).toContainText('Research model')

    await model.press('Home')
    await model.press('ArrowDown')
    await expectActive(model, models.getByRole('option', { name: 'Focused model', exact: true }))
    await model.press('Enter')
    await expect(model).toContainText('Focused model')
    await expect(model).toBeFocused()
    await effort.press('End')
    await expectActive(effort, efforts.getByRole('option', { name: '深入', exact: true }))
    await effort.press('Space')
    await expect(effort).toContainText('深入')
    await expect(efforts).toHaveCount(0)

    await model.press('End')
    await page.getByRole('button', { name: '切换浅色外观', exact: true }).click()
    await expect(models).toHaveCount(0)
    await expect(page.getByRole('button', { name: '切换深色外观', exact: true })).toBeFocused()
    await expect(model).toContainText('Focused model')
    await chooseCodexOption(page, 'Codex 模型', 'Research model')
    await chooseCodexOption(page, '思考深度', '最深入')
    await chooseCodexOption(page, 'Codex 模型', 'Focused model')
    await expect(effort).toContainText('深入')
    await page.reload()
    await openQuotedAssistant(page, false)
    await expect(model).toContainText('Focused model')
    await expect(effort).toContainText('深入')

    await page.getByRole('textbox', { name: '向 Codex 提问', exact: true }).fill('请使用所选模型解释。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect.poll(() => calls.length).toBe(1)
    await expect(model).toBeDisabled()
    await expect(effort).toBeDisabled()
    await expect(page.getByRole('button', { name: '刷新 Codex 模型', exact: true })).toBeDisabled()
    await expect(page.getByRole('listbox')).toHaveCount(0)
    expect(calls[0]).toMatchObject({ model: 'rich-focused', reasoningEffort: 'high', question: '请使用所选模型解释。' })
    expect(calls[0].quote.trim()).not.toBe('')
    release()
    await expect(page.locator('.codex-message.assistant')).toContainText('已按键盘选择的设置回答')
    await expect(model).toBeEnabled()
    await expect(effort).toBeEnabled()
  } finally { release() }
})

const longSum = String.raw`\underbrace{${Array.from({ length: 60 }, (_, index) => `a_{${index + 1}}`).join(' + ')}}_{\text{long sum}}=\sum_{i=1}^{60}a_i`
const validMath = [
  'E=mc^2', String.raw`\alpha+\beta=\gamma`, String.raw`\int_0^1 x^2\,dx=\frac{1}{3}`,
  String.raw`\mathbf{A}\mathbf{x}=\mathbf{b}`, longSum,
  String.raw`\frac{\sum_{i=1}^{n}i^2}{\sqrt{1+\frac{x}{y}}}`,
]
const code = [
  'function explain(value: number) {',
  String.raw`  const literal = "$notMath$, \(also not math\)";`,
  '  return value ** 2;',
  '}',
  '// ' + 'long_code_identifier_'.repeat(22),
].join('\n')
const richAnswer = [
  '## 阅读回答',
  '**关键结论**：先核对假设，再检查推导。',
  `行内公式 $${validMath[0]}$，另一个定界符 \\(${validMath[1]}\\)。`,
  `$$${validMath[2]}$$`,
  `\\[${validMath[3]}\\]`,
  `$$${validMath[4]}$$`,
  `$$${validMath[5]}$$`,
  '- [x] 已核对假设\n- [ ] 继续检查结论',
  ['| 步骤 | 检查内容 | 结论 |', '| :--- | :--- | ---: |',
    '| 1 | 核对假设 | 通过 |', `| 2 | ${'scientific_evidence_'.repeat(20)} | 待复核 |`].join('\n'),
  ['```typescript', code, '```'].join('\n'),
  '```readerunknown\nrender_this_unknown_language(raw_value)\n```',
  '行内代码 `\\(literal inline\\)` 应保持原样。',
  String.raw`价格 \$5 与 \$10 保持货币文字。`,
  String.raw`错误公式保持可读：$\notARealCommand{broken}$`,
  '', '未闭合公式仍然可读：$lonely', '',
  '<img src="x" onerror="window.__richUnsafe=true"><script>window.__richUnsafe=true</script>',
  '<iframe src="https://example.invalid/unsafe"></iframe>',
  '![外部图片不自动加载](https://example.invalid/rich-test-image.png)',
  '[不安全链接](javascript:alert(1)) · [安全参考](https://example.com/reference)',
].join('\n\n')

async function expectLocalHorizontalScroll(locator: Locator) {
  await expect.poll(() => locator.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(1)
  const moved = await locator.evaluate(element => { element.scrollLeft = element.scrollWidth; const value = element.scrollLeft; element.scrollLeft = 0; return value })
  expect(moved).toBeGreaterThan(1)
}

for (const [name, viewport] of [
  ['desktop', { width: 1512, height: 1100 }],
  ['mobile', { width: 390, height: 844 }],
] as const) {
  test(`renders and copies safe rich answers with readable formulas and contained wide content on ${name}`, async ({ page }) => {
    const errors: string[] = [], remoteImages: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (request.url().includes('rich-test-image.png')) remoteImages.push(request.url()) })
    // Capture the clipboard boundary without touching the user's system clipboard.
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { (window as unknown as { __folioCopiedText: string }).__folioCopiedText = value },
    } }))
    const calls = await stubCodex(page, richAnswer)
    await page.setViewportSize(viewport)
    await openQuotedAssistant(page)
    await page.getByRole('textbox', { name: '向 Codex 提问', exact: true }).fill('请给出有公式、表格和示例代码的回答。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    const reply = page.locator('.codex-message.assistant')
    const codeBlock = reply.locator('.codex-code-block').filter({ hasText: 'function explain' })
    await expect(reply.getByRole('heading', { name: '阅读回答', exact: true })).toBeVisible()
    await expect(reply.getByRole('table').getByRole('columnheader', { name: '检查内容', exact: true })).toHaveCount(1)
    await expect(reply.getByRole('table').getByRole('cell', { name: '待复核', exact: true })).toHaveCount(1)
    await expect(reply.getByRole('checkbox').first()).toBeChecked()
    await expect(reply.getByRole('checkbox').nth(1)).not.toBeChecked()
    const formulas = await reply.locator('.katex-mathml annotation[encoding="application/x-tex"]').allTextContents()
    for (const formula of validMath) expect(formulas.map(value => value.replace(/\s/g, ''))).toContain(formula.replace(/\s/g, ''))
    await expect(reply.locator('.katex-display')).toHaveCount(4)
    await expect(reply).toContainText('价格 $5 与 $10 保持货币文字。')
    await expect(reply).toContainText('未闭合公式仍然可读：$lonely')
    await expect(reply).toContainText('notARealCommand')
    await expect(reply.locator('code').filter({ hasText: String.raw`\(literal inline\)` })).toHaveCount(1)
    await expect(reply.locator('.codex-code-block .katex')).toHaveCount(0)
    await expect(reply.locator('.codex-code-block .hljs-keyword').filter({ hasText: 'function' })).toHaveCount(1)
    await expect(codeBlock.locator('.codex-code-language')).toHaveText(/typescript/i)
    await expect(reply.locator('.codex-code-block').filter({ hasText: 'readerunknown' }).locator('code')).toHaveText('render_this_unknown_language(raw_value)\n')
    await expect(reply.locator('img, script, iframe')).toHaveCount(0)
    await expect(reply.locator('a[href^="javascript:"]')).toHaveCount(0)
    await expect(reply.getByRole('link', { name: '安全参考', exact: true })).toHaveAttribute('href', 'https://example.com/reference')
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__richUnsafe)).toBeUndefined()
    expect(remoteImages).toEqual([])
    expect(calls).toHaveLength(1)

    await codeBlock.getByRole('button', { name: '复制代码', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __folioCopiedText?: string }).__folioCopiedText?.trimEnd())).toBe(code)
    await expect(codeBlock.getByRole('button', { name: '复制代码', exact: true })).toContainText('已复制')
    await reply.getByRole('button', { name: '复制回答', exact: true }).click()
    await expect.poll(() => page.evaluate(() => (window as unknown as { __folioCopiedText?: string }).__folioCopiedText)).toBe(richAnswer)

    await expectLocalHorizontalScroll(reply.locator('.codex-table-scroll'))
    await expectLocalHorizontalScroll(codeBlock.locator('pre'))
    await expectLocalHorizontalScroll(reply.locator('.katex-display').nth(2))
    await page.evaluate(() => document.fonts.ready)
    const tallFormula = reply.locator('.katex-display').last()
    expect(await tallFormula.evaluate(element => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(1)
    await mkdir('tmp', { recursive: true })
    await tallFormula.screenshot({ path: `tmp/codex-rich-math-${name}.png` })
    for (const theme of ['dark', 'light']) {
      if (theme === 'light') await page.getByRole('button', { name: '切换浅色外观', exact: true }).click()
      await expect(page.locator('.app-shell')).toHaveAttribute('data-theme', theme)
      const panel = page.locator('.codex-panel')
      expect(await panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      const box = await panel.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1)
      await page.locator('.codex-conversation').evaluate(element => { element.scrollTop = 0 })
      await expect(page.locator('#page-1 .pdf-page-placeholder')).toBeHidden()
      await page.screenshot({ path: `tmp/codex-rich-${theme}-${name}.png` })
      if (theme === 'dark') await page.screenshot({ path: `tmp/codex-composer-${name}.png` })
    }
    expect(errors).toEqual([])
  })
}
