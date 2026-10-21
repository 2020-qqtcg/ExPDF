import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { openFileMenu, selectTool, fileAction, closeFileMenu } from './helpers/reader'
import { chooseCodexOption } from './helpers/codex'

const SETTINGS_KEY = 'folio-codex-settings-v1'
const catalog = {
  defaultModel: 'test-research',
  models: [
    { id: 'test-research', name: 'Research model', description: 'Supports deeper reasoning.', reasoningLevels: [{ id: 'low', label: '快速' }, { id: 'medium', label: '标准' }, { id: 'ultra', label: '最深入' }], defaultReasoningLevel: 'medium' },
    { id: 'test-focused', name: 'Focused model', reasoningLevels: [{ id: 'medium', label: '标准' }, { id: 'high', label: '深入' }], defaultReasoningLevel: 'medium' },
    { id: 'test-auto', name: 'Automatic model', reasoningLevels: [], defaultReasoningLevel: '' },
  ],
}
interface Ask { model?: string; reasoningEffort?: string; question: string; quote: string }

async function stubCodex(page: Page, answer: (body: Ask, index: number) => Promise<string> | string = () => '模型选择已生效。') {
  const calls: Ask[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: catalog }))
  // Never invoke the real model from browser acceptance tests.
  await page.route('**/api/codex/ask', async route => {
    const body = route.request().postDataJSON() as Ask
    calls.push(body)
    const result = await answer(body, calls.length - 1)
    await route.fulfill({ json: { answer: result } }).catch(() => {})
  })
  return calls
}

async function openCodex(page: Page) {
  await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  const panel = page.getByRole('complementary', { name: 'Codex 问答' })
  await expect(panel).toBeVisible()
  return panel
}

async function selectPassage(page: Page) {
  await selectTool(page, '选择文本')
  const span = page.locator('#page-1 .textLayer span').filter({ hasText: /\S/ }).first()
  await expect(span).toBeVisible()
  await span.evaluate(element => {
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
  })
  await page.getByRole('toolbar', { name: '选中文字工具', exact: true }).getByRole('button', { name: '问 Codex', exact: true }).click()
}

test('reads the installed CLI model capabilities without starting a model request', async ({ request }) => {
  const response = await request.get('/api/codex/models')
  expect(response.ok()).toBe(true)
  const actual = await response.json() as typeof catalog
  expect(actual.models.length).toBeGreaterThan(0)
  expect(actual.models.some(model => model.id === actual.defaultModel)).toBe(true)
  expect(new Set(actual.models.map(model => model.id)).size).toBe(actual.models.length)
  for (const model of actual.models) {
    expect(model.id.trim()).not.toBe('')
    expect(model.name.trim()).not.toBe('')
    if (model.reasoningLevels.length) expect(model.reasoningLevels.map(level => level.id)).toContain(model.defaultReasoningLevel)
    for (const level of model.reasoningLevels) {
      expect(level.id.trim()).not.toBe('')
      expect(level.label.trim()).not.toBe('')
    }
  }
})

test('persists per-model reasoning, falls back to supported levels, and sends frozen settings while generating', async ({ page }) => {
  let release = () => {}
  const pending = new Promise<void>(resolve => { release = resolve })
  const calls = await stubCodex(page, async (_body, index) => { if (index === 0) await pending; return '已使用所选模型和思考深度。' })
  try {
    await page.goto('/')
    await expect(page.locator('#page-1 canvas')).toBeVisible()
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ model: 'test-research', reasoningByModel: { 'test-focused': 'ultra' } })), SETTINGS_KEY)
    await openCodex(page)
    const model = page.getByRole('combobox', { name: 'Codex 模型', exact: true })
    const effort = page.getByRole('combobox', { name: '思考深度', exact: true })
    await expect(model).toContainText('Research model')
    await expect(effort).toContainText('标准')
    await chooseCodexOption(page, '思考深度', '最深入')
    await chooseCodexOption(page, 'Codex 模型', 'Focused model')
    await expect(effort).toContainText('标准')
    await effort.click()
    await expect(page.getByRole('listbox', { name: '思考深度', exact: true }).getByRole('option', { name: /^最深入/ })).toHaveCount(0)
    await effort.press('Escape')
    await chooseCodexOption(page, '思考深度', '深入')
    await chooseCodexOption(page, 'Codex 模型', 'Automatic model')
    await expect(effort).toBeDisabled()
    await expect(effort).toContainText('自动')
    await chooseCodexOption(page, 'Codex 模型', 'Research model')
    await expect(effort).toContainText('最深入')
    await chooseCodexOption(page, 'Codex 模型', 'Focused model')
    await expect(effort).toContainText('深入')
    await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? '{}'), SETTINGS_KEY)).toMatchObject({ model: 'test-focused', reasoningByModel: { 'test-focused': 'high', 'test-research': 'ultra' } })
    await page.reload()
    await expect(page.locator('#page-1 canvas')).toBeVisible()
    await openCodex(page)
    await expect(model).toContainText('Focused model')
    await expect(effort).toContainText('深入')
    await selectPassage(page)
    const input = page.getByRole('textbox', { name: '向 Codex 提问', exact: true })
    await input.fill('请按所选设置解释这段。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect.poll(() => calls.length).toBe(1)
    expect(calls[0]).toMatchObject({ model: 'test-focused', reasoningEffort: 'high', question: '请按所选设置解释这段。' })
    expect(calls[0].quote.trim()).not.toBe('')
    await expect(model).toBeDisabled()
    await expect(effort).toBeDisabled()
    await expect(input).toBeDisabled()
    release()
    await expect(page.locator('.codex-message.assistant')).toContainText('已使用所选模型和思考深度')
    await expect(model).toBeEnabled()
    await expect(effort).toBeEnabled()
    await chooseCodexOption(page, 'Codex 模型', 'Research model')
    await expect(effort).toContainText('最深入')
    await input.fill('使用另一模型继续。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.locator('.codex-message.assistant')).toHaveCount(2)
    expect(calls[1]).toMatchObject({ model: 'test-research', reasoningEffort: 'ultra' })
  } finally { release() }
})

test('keeps default Codex questions working when the capability service is unavailable', async ({ page }) => {
  const calls = await stubCodex(page)
  await page.route('**/api/codex/models*', route => route.fulfill({ status: 503, json: { error: 'Catalog unavailable' } }))
  await page.goto('/')
  await expect(page.locator('#page-1 canvas')).toBeVisible()
  await selectPassage(page)
  await expect(page.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeDisabled()
  await expect(page.getByRole('combobox', { name: '思考深度', exact: true })).toBeDisabled()
  await expect(page.getByText('使用 Codex 默认配置', { exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: '向 Codex 提问', exact: true }).fill('默认配置也应能提问。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.locator('.codex-message.assistant')).toContainText('模型选择已生效')
  expect(calls).toHaveLength(1)
  expect(calls[0]).not.toHaveProperty('model')
  expect(calls[0]).not.toHaveProperty('reasoningEffort')
})

for (const [name, viewport] of [
  ['desktop', { width: 1512, height: 1100 }],
  ['narrow', { width: 390, height: 844 }],
] as const) {
  test(`keeps the ${name} reader and model controls within the viewport and persists the chosen appearance`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    const calls = await stubCodex(page)
    await page.setViewportSize(viewport)
    await page.goto('/')
    await expect(page.locator('#page-1 canvas')).toBeVisible()
    const shell = page.locator('.app-shell')
    await expect(shell).toHaveAttribute('data-theme', 'dark')
    const assertFits = async (selector: string) => {
      const bounds = await page.locator(selector).boundingBox()
      expect(bounds, `${selector} is present`).not.toBeNull()
      expect(bounds!.x, `${selector} left edge`).toBeGreaterThanOrEqual(-1)
      expect(bounds!.x + bounds!.width, `${selector} right edge`).toBeLessThanOrEqual(viewport.width + 1)
    }
    const assertNoPageOverflow = async () => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width)
      for (const selector of ['.workspace', '.document-tabs', '.toolbar', '.reader-layout']) await assertFits(selector)
    }
    const waitForPaintedDocument = async () => {
      await expect(page.locator('#page-1 .pdf-page-placeholder')).toBeHidden()
      await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
      await page.evaluate(() => document.fonts.ready)
      if (name === 'desktop') await expect.poll(() => page.locator('.thumbnail-canvas').first().evaluate(element => {
        const canvas = element as HTMLCanvasElement
        const pixels = canvas.getContext('2d')?.getImageData(0, 0, canvas.width, canvas.height).data
        let dark = 0, light = 0
        for (let index = 0; pixels && index < pixels.length; index += 4) {
          if (pixels[index + 3] && pixels[index] < 160 && pixels[index + 1] < 160 && pixels[index + 2] < 160) dark++
          if (pixels[index] > 220 && pixels[index + 1] > 220 && pixels[index + 2] > 220) light++
        }
        return dark > 40 && light > 1000
      })).toBe(true)
    }
    await assertNoPageOverflow()
    await expect(page.getByRole('navigation', { name: '阅读导航' })).toBeVisible()
    if (name === 'desktop') {
      const rail = await page.locator('.navigation-rail').boundingBox()
      expect(rail!.width).toBeGreaterThanOrEqual(44)
      expect(rail!.width).toBeLessThanOrEqual(52)
      const tabs = await page.locator('.document-tabs').boundingBox()
      expect(tabs!.height).toBeLessThanOrEqual(48)
      await expect(await openFileMenu(page)).toBeVisible()
      await expect(await fileAction(page, '导出 PDF')).toBeVisible()
      await closeFileMenu(page)
    }
    await openCodex(page)
    const model = page.getByRole('combobox', { name: 'Codex 模型', exact: true })
    const effort = page.getByRole('combobox', { name: '思考深度', exact: true })
    await expect(model).toBeEnabled()
    await expect(model).toBeInViewport({ ratio: 1 })
    await expect(effort).toBeInViewport({ ratio: 1 })
    await assertFits('.codex-panel')
    await assertNoPageOverflow()
    await waitForPaintedDocument()
    await mkdir('tmp', { recursive: true })
    await page.screenshot({ path: `tmp/reader-design-dark-${name}.png` })
    await page.getByRole('button', { name: '关闭 Codex 侧栏', exact: true }).click()
    await page.getByRole('button', { name: '切换浅色外观', exact: true }).click()
    await expect(shell).toHaveAttribute('data-theme', 'light')
    await page.reload()
    await expect(page.locator('#page-1 canvas')).toBeVisible()
    await expect(shell).toHaveAttribute('data-theme', 'light')
    await expect(page.getByRole('button', { name: '切换深色外观', exact: true })).toBeVisible()
    await openCodex(page)
    await expect(model).toBeEnabled()
    await assertNoPageOverflow()
    await waitForPaintedDocument()
    await page.screenshot({ path: `tmp/reader-design-light-${name}.png` })
    expect(calls).toEqual([])
    expect(errors).toEqual([])
  })
}
