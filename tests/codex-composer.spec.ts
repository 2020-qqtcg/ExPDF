import { test, expect, type Locator, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { chooseCodexOption } from './helpers/codex'

type Json = Record<string, any>
const shortModel = 'Model X'
const longModel = 'A deliberately long research model name that must fit its compact control'
const longEffort = '深入思考：完整检查每一个推理条件'
const panelFor = (page: Page) => page.getByRole('complementary', { name: 'Codex 问答' })

async function setup(page: Page) {
  const calls: Json[] = []
  const releases = new Map<number, (value: string) => void>()
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: { defaultModel: 'composer-short', models: [
    { id: 'composer-short', name: shortModel, reasoningLevels: [{ id: 'low', label: '快' }, { id: 'high', label: longEffort }], defaultReasoningLevel: 'low' },
    { id: 'composer-long', name: longModel, reasoningLevels: [{ id: 'low', label: '快' }, { id: 'high', label: longEffort }], defaultReasoningLevel: 'low' },
  ] } }))
  await page.route('**/api/codex/ask', async route => {
    const index = calls.push(route.request().postDataJSON()) - 1
    const answer = await new Promise<string>(resolve => releases.set(index, resolve))
    await route.fulfill({ json: { answer } }).catch(() => {})
  })
  await page.goto('/')
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  const panel = panelFor(page)
  await expect(panel.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
  const input = panel.getByRole('textbox', { name: '向 Codex 提问', exact: true })
  const answer = async (index: number) => {
    await expect.poll(() => calls.length).toBe(index + 1)
    releases.get(index)!(`模拟回答 ${index + 1}`)
    await expect(panel.locator('.codex-message.assistant').last()).toContainText(`模拟回答 ${index + 1}`)
    await expect(input).toBeEnabled()
  }
  const cleanup = () => { for (const release of releases.values()) release('测试结束') }
  return { calls, panel, input, answer, cleanup }
}

async function settleKeyboard(page: Page) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

test('sends the initial question and completed follow-ups with Enter, keeps Shift+Enter multiline, and ignores a held Enter repeat', async ({ page }) => {
  const fake = await setup(page)
  try {
    await fake.input.fill('   ')
    await fake.input.press('Enter')
    await settleKeyboard(page)
    expect(fake.calls).toHaveLength(0)
    await expect(fake.input).toBeEnabled()
    await fake.input.fill('第一行问题')
    await fake.input.press('Shift+Enter')
    await fake.input.pressSequentially('第二行问题')
    await expect(fake.input).toHaveValue('第一行问题\n第二行问题')
    expect(fake.calls).toHaveLength(0)

    await page.keyboard.down('Enter')
    await expect.poll(() => fake.calls.length).toBe(1)
    expect(fake.calls[0].question).toBe('第一行问题\n第二行问题')
    await fake.answer(0)
    // The key remains physically held through completion. A browser repeat
    // reaching an enabled follow-up field must not submit the next draft.
    await fake.input.fill('完成后继续追问')
    await page.keyboard.down('Enter')
    await settleKeyboard(page)
    expect(fake.calls).toHaveLength(1)
    await expect(fake.input).toBeEnabled()
    await expect(fake.input).toHaveValue('完成后继续追问')
    await page.keyboard.up('Enter')
    await fake.input.press('Enter')
    await fake.answer(1)
    expect(fake.calls[1].question).toBe('完成后继续追问')
    expect(fake.calls[1].messages.map((message: Json) => message.role)).toEqual(['user', 'assistant'])
    for (const [index, shortcut] of ['Control+Enter', 'Meta+Enter'].entries()) {
      await fake.input.fill(`兼容快捷键 ${shortcut}`)
      await fake.input.press(shortcut)
      await fake.answer(index + 2)
      expect(fake.calls[index + 2].question).toBe(`兼容快捷键 ${shortcut}`)
    }
    expect(fake.calls).toHaveLength(4)
  } finally {
    await page.keyboard.up('Enter')
    fake.cleanup()
  }
})

test('does not submit IME confirmation or model-picker Enter, and accepts a fresh Enter after composition ends', async ({ page }) => {
  const fake = await setup(page)
  try {
    await fake.input.fill('中文输入确认时仍是草稿')
    await fake.input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, isComposing: true, bubbles: true })
    await fake.input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, which: 229, isComposing: false, bubbles: true })
    await fake.input.dispatchEvent('compositionstart', { data: '输入法' })
    await fake.input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, isComposing: false, bubbles: true })
    await settleKeyboard(page)
    expect(fake.calls).toHaveLength(0)
    await expect(fake.input).toBeEnabled()
    await expect(fake.input).toHaveValue('中文输入确认时仍是草稿')
    await fake.input.dispatchEvent('compositionend', { data: '输入法' })

    const model = fake.panel.getByRole('combobox', { name: 'Codex 模型', exact: true })
    await model.press('End')
    await model.press('Enter')
    await expect(model).toContainText(longModel)
    await expect(model).toBeFocused()
    const effort = fake.panel.getByRole('combobox', { name: '思考深度', exact: true })
    await effort.press('End')
    await effort.press('Enter')
    await expect(effort).toContainText(longEffort)
    await settleKeyboard(page)
    expect(fake.calls).toHaveLength(0)
    await expect(fake.input).toHaveValue('中文输入确认时仍是草稿')
    await fake.input.focus()
    await fake.input.press('Enter')
    await fake.answer(0)
    expect(fake.calls[0]).toMatchObject({ question: '中文输入确认时仍是草稿', model: 'composer-long', reasoningEffort: 'high' })
  } finally { fake.cleanup() }
})

async function bounds(locator: Locator) {
  const value = await locator.boundingBox()
  expect(value).not.toBeNull()
  return value!
}

test('keeps short and long model settings at fixed widths next to send across resized and narrow panels', async ({ page }) => {
  const fake = await setup(page)
  try {
    const handle = fake.panel.getByRole('separator', { name: '调整 Codex 侧栏宽度', exact: true })
    const measure = async (normalWidth: boolean) => {
      const model = await bounds(fake.panel.getByRole('combobox', { name: 'Codex 模型', exact: true }))
      const effort = await bounds(fake.panel.getByRole('combobox', { name: '思考深度', exact: true }))
      const settings = await bounds(fake.panel.locator('.codex-settings'))
      const send = await bounds(fake.panel.getByRole('button', { name: '发送问题', exact: true }))
      const row = await bounds(fake.panel.locator('.codex-send-row'))
      expect(effort.width).toBeCloseTo(64, 0)
      expect(send.width).toBeCloseTo(28, 0)
      expect(send.x - settings.x - settings.width).toBeCloseTo(8, 0)
      expect(send.x + send.width).toBeCloseTo(row.x + row.width, 0)
      expect(send.x - effort.x - effort.width).toBeCloseTo(32, 0)
      if (normalWidth) {
        expect(model.width).toBeCloseTo(128, 0)
        expect(settings.width).toBeCloseTo(220, 0)
      } else {
        expect(model.width).toBeGreaterThanOrEqual(90)
        expect(model.width).toBeLessThan(128)
      }
      expect(await fake.panel.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1)
      for (const label of ['Codex 模型', '思考深度']) await expect(fake.panel.getByRole('combobox', { name: label, exact: true })).toBeInViewport({ ratio: 1 })
      return { model: model.width, effort: effort.width, gap: send.x - settings.x - settings.width }
    }
    for (const width of [330, 390, 620, 280]) {
      const current = await bounds(fake.panel), grip = await bounds(handle)
      const x = grip.x + grip.width / 2, y = grip.y + 150
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + current.width - width, y, { steps: 12 })
      await page.mouse.up()
      await expect.poll(async () => (await bounds(fake.panel)).width).toBeCloseTo(width, 0)
      await chooseCodexOption(page, 'Codex 模型', shortModel)
      await chooseCodexOption(page, '思考深度', '快')
      const short = await measure(width >= 330)
      await chooseCodexOption(page, 'Codex 模型', longModel)
      await chooseCodexOption(page, '思考深度', longEffort)
      const long = await measure(width >= 330)
      expect(long).toEqual(short)
      if (width === 620) {
        await mkdir('tmp', { recursive: true })
        await page.screenshot({ path: 'tmp/codex-composer-fixed-desktop.png' })
      }
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(async () => (await bounds(fake.panel)).width).toBeCloseTo(280, 0)
    await measure(false)
    await page.screenshot({ path: 'tmp/codex-composer-fixed-mobile.png' })
    expect(fake.calls).toEqual([])
  } finally { fake.cleanup() }
})
