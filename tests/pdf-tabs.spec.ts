import { test, expect, type Page } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { makePdfFixture, type PdfFixture } from './helpers/pdf-fixture'
import { clickFileAction, clickReadingControl, closeFileMenu, fileAction, selectTool, showAnnotations, useFixedZoom, wakeReadingControls } from './helpers/reader'

type Json = Record<string, any>
const tabs = (page: Page) => page.getByRole('tablist').getByRole('tab')
const pdfTab = (page: Page, name: string) => page.getByRole('tab', { name: `切换到 PDF：${name}`, exact: true })
const panel = (page: Page) => page.getByRole('complementary', { name: 'Codex 问答', exact: true })

async function startEmpty(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  while (await page.getByRole('button', { name: '关闭当前 PDF', exact: true }).count()) {
    const previousCount = await tabs(page).count()
    await page.getByRole('button', { name: '关闭当前 PDF', exact: true }).click()
    await expect(tabs(page)).toHaveCount(previousCount - 1)
  }
  await expect(page.locator('.welcome-empty')).toBeVisible()
  await expect(tabs(page)).toHaveCount(0)
}

async function upload(page: Page, files: PdfFixture[]) {
  await page.getByLabel('选择 PDF 文件', { exact: true }).setInputFiles(files)
  for (const file of files) await expect(pdfTab(page, file.name)).toBeVisible()
}

async function activate(page: Page, file: PdfFixture, pageNumber?: number) {
  await pdfTab(page, file.name).click()
  await expect(pdfTab(page, file.name)).toHaveAttribute('aria-selected', 'true')
  await expect(page).toHaveTitle(new RegExp(file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  if (pageNumber) await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue(String(pageNumber))
  const number = pageNumber ?? Number(await page.getByRole('textbox', { name: '当前页码', exact: true }).inputValue())
  await expect(page.locator(`#page-${number} .textLayer`)).toContainText(file.label)
}

async function dragFiles(page: Page, files: PdfFixture[]) {
  const transfer = await page.evaluateHandle(items => {
    const transfer = new DataTransfer()
    for (const file of items) transfer.items.add(new File([new Uint8Array(file.bytes)], file.name, { type: 'application/pdf' }))
    return transfer
  }, files.map(file => ({ name: file.name, bytes: [...file.buffer] })))
  await page.locator('.app-shell').dispatchEvent('dragover', { dataTransfer: transfer })
  await page.locator('.app-shell').dispatchEvent('drop', { dataTransfer: transfer })
  await transfer.dispose()
}

async function addNote(page: Page, text: string) {
  await selectTool(page, '便签')
  await page.locator('#page-1').click({ position: { x: 100, y: 245 } })
  await page.getByRole('textbox', { name: '标注内容', exact: true }).fill(text)
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.locator('.annotation-card').filter({ hasText: text })).toBeVisible()
}

async function readAt(page: Page, number: number, offset = 125) {
  await wakeReadingControls(page)
  const input = page.getByRole('textbox', { name: '当前页码', exact: true })
  await input.fill(String(number))
  await input.press('Enter')
  await expect(input).toHaveValue(String(number))
  await expect(page.locator(`#page-${number} .textLayer span`).first()).toBeVisible()
  await page.locator('.document-scroll').evaluate((element, { number, offset }) => {
    const sheet = element.querySelector(`#page-${number}`) as HTMLElement
    element.scrollTop += sheet.getBoundingClientRect().top - element.getBoundingClientRect().top + offset
  }, { number, offset })
  await expect(input).toHaveValue(String(number))
  return readingOffset(page, number)
}

async function readingOffset(page: Page, number: number) {
  return page.locator('.document-scroll').evaluate((element, number) => {
    const sheet = element.querySelector(`#page-${number}`)!
    return element.getBoundingClientRect().top - sheet.getBoundingClientRect().top
  }, number)
}

async function normalizedReadingPoint(page: Page, number: number) {
  return page.locator('.document-scroll').evaluate((element, number) => {
    const viewport = element.getBoundingClientRect()
    const paper = element.querySelector(`#page-${number}`)!.getBoundingClientRect()
    return {
      x: (viewport.left + element.clientWidth / 2 - paper.left) / paper.width,
      y: (viewport.top + element.clientHeight / 3 - paper.top) / paper.height,
      width: paper.width,
    }
  }, number)
}

async function expectPosition(page: Page, number: number, offset: number, scale: string) {
  await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue(String(number))
  await expect(page.getByRole('combobox', { name: '缩放比例', exact: true })).toHaveValue(scale)
  await expect.poll(async () => Math.abs(await readingOffset(page, number) - offset)).toBeLessThan(3)
}

async function mockAgent(page: Page) {
  const calls: Json[] = []
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true, agent: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: { defaultModel: 'tabs-test-model', models: [{ id: 'tabs-test-model', name: 'Tab test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }] } }))
  await page.route('**/api/codex/agent/status*', route => route.fulfill({ json: { available: true, desktopControl: false, capabilities: [], mcpServers: [], skills: [] } }))
  await page.route('**/api/codex/agent/interrupt', route => route.fulfill({ json: { ok: true } }))
  await page.route('**/api/codex/ask', route => route.abort())
  await page.route('**/api/codex/agent/run', route => {
    const body = route.request().postDataJSON()
    calls.push(body)
    const runId = `tabs-run-${calls.length}`, threadId = `tabs-thread-${body.documentId.slice(0, 16)}`
    const events = [
      { type: 'thread', runId, threadId, workspace: '/private/isolated-tabs-test' },
      { type: 'complete', runId, threadId, status: 'completed', answer: `模拟回答：${body.question}` },
    ]
    return route.fulfill({ contentType: 'text/event-stream; charset=utf-8', body: events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') })
  })
  const show = async () => {
    if (!await panel(page).isVisible()) await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
    await expect(panel(page).getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
  }
  const send = async (question: string) => {
    await show()
    const before = calls.length
    await panel(page).getByRole('textbox', { name: '向 Codex 提问', exact: true }).fill(question)
    await panel(page).getByRole('button', { name: '发送问题', exact: true }).click()
    await expect.poll(() => calls.length).toBe(before + 1)
    await expect(panel(page).locator('.codex-message.assistant').last()).toContainText(`模拟回答：${question}`)
    return calls.at(-1)!
  }
  const annotations = async () => {
    if (await panel(page).isVisible()) await panel(page).getByRole('button', { name: '返回标注', exact: true }).click()
    await showAnnotations(page)
  }
  return { calls, show, send, annotations }
}

test('opens every selected and dropped PDF, focuses duplicate content, and keeps rapid arrivals without losing tabs', async ({ page }) => {
  await startEmpty(page)
  const [alpha, beta, gamma, delta, epsilon, raceA, raceB] = await Promise.all([
    ['tabs-alpha.pdf', 'Tab Alpha'], ['tabs-beta.pdf', 'Tab Beta'], ['tabs-gamma.pdf', 'Tab Gamma'],
    ['tabs-delta.pdf', 'Tab Delta'], ['tabs-epsilon.pdf', 'Tab Epsilon'],
    ['tabs-race-a.pdf', 'Rapid Alpha'], ['tabs-race-b.pdf', 'Rapid Beta'],
  ].map(([name, label]) => makePdfFixture(name, label)))
  await expect(page.getByLabel('选择 PDF 文件')).toHaveAttribute('multiple', '')
  await upload(page, [alpha, beta, gamma])
  await expect(tabs(page)).toHaveCount(3)
  expect(await tabs(page).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).toEqual(['切换到 PDF：tabs-alpha.pdf', '切换到 PDF：tabs-beta.pdf', '切换到 PDF：tabs-gamma.pdf'])
  await expect(pdfTab(page, gamma.name)).toHaveAttribute('aria-selected', 'true')
  await page.getByLabel('选择 PDF 文件').setInputFiles({ ...beta, name: 'renamed-copy-of-beta.pdf' })
  await expect(tabs(page)).toHaveCount(3)
  await expect(pdfTab(page, beta.name)).toHaveAttribute('aria-selected', 'true')
  await expect(pdfTab(page, 'renamed-copy-of-beta.pdf')).toHaveCount(0)
  await dragFiles(page, [delta, epsilon])
  await expect(tabs(page)).toHaveCount(5)
  await expect(pdfTab(page, delta.name)).toBeVisible()
  await expect(pdfTab(page, epsilon.name)).toHaveAttribute('aria-selected', 'true')

  // Hold the first File read while another independent open arrives. Both UI
  // operations must survive, rather than letting the latest load invalidate it.
  await page.evaluate(() => {
    const original = File.prototype.arrayBuffer
    File.prototype.arrayBuffer = async function () {
      if (this.name === 'tabs-race-a.pdf') await new Promise(resolve => setTimeout(resolve, 180))
      return original.call(this)
    }
  })
  await dragFiles(page, [raceA])
  await page.getByLabel('选择 PDF 文件').setInputFiles(raceB)
  await expect(tabs(page)).toHaveCount(7)
  await expect(pdfTab(page, raceB.name)).toHaveAttribute('aria-selected', 'true')
  expect((await tabs(page).evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))).slice(-2)).toEqual([`切换到 PDF：${raceA.name}`, `切换到 PDF：${raceB.name}`])
  for (const file of [alpha, beta, gamma, delta, epsilon, raceA, raceB]) await activate(page, file, 1)
  await expect(pdfTab(page, raceB.name)).toHaveAttribute('aria-selected', 'true')
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1)
})

test('keeps each PDF reading position, zoom, rotation, undo stack, annotations and chat independent and restores open tabs after reload', async ({ page }) => {
  test.setTimeout(65_000)
  const fake = await mockAgent(page)
  await startEmpty(page)
  const alpha = await makePdfFixture('state-alpha.pdf', 'State Alpha')
  const beta = await makePdfFixture('state-beta.pdf', 'State Beta')
  await upload(page, [alpha, beta])

  await activate(page, alpha, 1)
  await showAnnotations(page)
  await useFixedZoom(page, '1.25')
  await addNote(page, 'A 文档独有便签一')
  await addNote(page, 'A 文档独有便签二')
  await clickFileAction(page, '撤销')
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  const alphaAsk = await fake.send('只讨论 A 的内容')
  await fake.annotations()
  const alphaOffset = await readAt(page, 2, 155)

  await activate(page, beta, 1)
  await showAnnotations(page)
  await useFixedZoom(page, '1.5')
  await addNote(page, 'B 文档独有便签')
  const betaAsk = await fake.send('只讨论 B 的内容')
  expect(betaAsk.documentId).not.toBe(alphaAsk.documentId)
  expect(betaAsk.messages).toEqual([])
  expect(betaAsk.threadId).toBeUndefined()
  await fake.annotations()
  await clickReadingControl(page, '旋转页面')
  const betaOffset = await readAt(page, 3, 80)

  await activate(page, alpha, 2)
  await expectPosition(page, 2, alphaOffset, '1.25')
  await expect.poll(() => page.locator('#page-2').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(612 * 1.25, 0)
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toContainText('A 文档独有便签一')
  await clickFileAction(page, '撤销')
  await expect(page.locator('.annotation-card')).toHaveCount(0)
  await clickFileAction(page, '重做')
  await clickFileAction(page, '重做')
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await fake.show()
  await expect(panel(page).getByRole('log', { name: '问答记录' })).toContainText('只讨论 A 的内容')
  await expect(panel(page).getByRole('log', { name: '问答记录' })).not.toContainText('只讨论 B 的内容')
  const alphaFollowup = await fake.send('继续讨论 A')
  expect(alphaFollowup.documentId).toBe(alphaAsk.documentId)
  expect(alphaFollowup.threadId).toBe(`tabs-thread-${alphaAsk.documentId.slice(0, 16)}`)
  expect(alphaFollowup.messages.map((message: Json) => message.role)).toEqual(['user', 'assistant'])
  expect(JSON.stringify(alphaFollowup.messages)).not.toContain('只讨论 B')
  await fake.annotations()

  await activate(page, beta, 3)
  await expectPosition(page, 3, betaOffset, '1.5')
  await expect.poll(() => page.locator('#page-3').evaluate(element => element.getBoundingClientRect().width)).toBeCloseTo(792 * 1.5, 0)
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toContainText('B 文档独有便签')
  await clickFileAction(page, '撤销')
  await expect(page.locator('.annotation-card')).toHaveCount(0)
  await expect(await fileAction(page, '撤销')).toBeDisabled()
  await closeFileMenu(page)
  await clickFileAction(page, '重做')
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.save-state')).toHaveText('已保存到本机')

  await page.reload()
  await expect(tabs(page)).toHaveCount(2)
  await expect(pdfTab(page, beta.name)).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: '当前页码' })).toHaveValue('3')
  await showAnnotations(page)
  await expect(page.locator('.annotation-card')).toHaveCount(1)
  await expect(page.locator('.annotation-card')).toContainText('B 文档独有便签')
  await fake.show()
  await expect(panel(page).locator('.codex-message.assistant')).toHaveCount(1)
  await expect(panel(page).getByRole('log', { name: '问答记录' })).toContainText('只讨论 B 的内容')
  await expect(panel(page).getByRole('log', { name: '问答记录' })).not.toContainText('继续讨论 A')
  await activate(page, alpha, 2)
  await fake.annotations()
  await expect(page.locator('.annotation-card')).toHaveCount(2)
  await fake.show()
  await expect(panel(page).locator('.codex-message.assistant')).toHaveCount(2)
  await expect(panel(page).getByRole('log', { name: '问答记录' })).toContainText('继续讨论 A')
  await expect(panel(page).getByRole('log', { name: '问答记录' })).not.toContainText('只讨论 B 的内容')
  await mkdir('tmp', { recursive: true })
  await page.screenshot({ path: 'tmp/pdf-tabs-state.png' })
})

test('closes inactive tabs without switching, selects the adjacent tab when closing active, and keeps an explicitly empty workspace after reload', async ({ page }) => {
  await startEmpty(page)
  const fixtures = await Promise.all(['alpha', 'beta', 'gamma', 'delta'].map(name => makePdfFixture(`close-${name}.pdf`, `Close ${name}`)))
  await upload(page, fixtures)
  const [alpha, beta, gamma, delta] = fixtures
  await expect(pdfTab(page, delta.name)).toHaveAttribute('aria-selected', 'true')
  await pdfTab(page, delta.name).press('Home')
  await expect(pdfTab(page, alpha.name)).toBeFocused()
  await expect(pdfTab(page, alpha.name)).toHaveAttribute('aria-selected', 'true')
  await pdfTab(page, alpha.name).press('End')
  await expect(pdfTab(page, delta.name)).toBeFocused()
  await pdfTab(page, delta.name).press('ArrowLeft')
  await expect(pdfTab(page, gamma.name)).toHaveAttribute('aria-selected', 'true')
  await pdfTab(page, gamma.name).press('ArrowRight')
  await expect(pdfTab(page, delta.name)).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: `关闭 PDF：${beta.name}`, exact: true }).click()
  await expect(tabs(page)).toHaveCount(3)
  await expect(pdfTab(page, delta.name)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#page-1 .textLayer')).toContainText(delta.label)
  await page.getByRole('button', { name: '关闭当前 PDF', exact: true }).click()
  await expect(tabs(page)).toHaveCount(2)
  await expect(pdfTab(page, gamma.name)).toHaveAttribute('aria-selected', 'true')
  await activate(page, alpha, 1)
  await page.getByRole('button', { name: '关闭当前 PDF', exact: true }).click()
  await expect(pdfTab(page, gamma.name)).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: '关闭当前 PDF', exact: true }).click()
  await expect(tabs(page)).toHaveCount(0)
  await expect(page.locator('.welcome-empty')).toBeVisible()
  await expect(page.locator('.pdf-page')).toHaveCount(0)
  await page.reload()
  await expect(page.locator('.welcome-empty')).toBeVisible()
  await expect(tabs(page)).toHaveCount(0)
  await page.getByRole('button', { name: '最近阅读', exact: true }).click()
  await page.getByRole('button', { name: `打开历史 PDF：${alpha.name}`, exact: true }).click()
  await expect(tabs(page)).toHaveCount(1)
  await expect(pdfTab(page, alpha.name)).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#page-1 .textLayer')).toContainText(alpha.label)
})

test('restores a searched PDF without navigating to its first match, keeps document drafts separate from new chats, and preserves its fit-width reading point after resize', async ({ page }) => {
  const fake = await mockAgent(page)
  await startEmpty(page)
  const alpha = await makePdfFixture('boundary-alpha.pdf', 'Boundary Alpha', 5)
  const beta = await makePdfFixture('boundary-beta.pdf', 'Boundary Beta', 4)
  await upload(page, [alpha, beta])
  await activate(page, alpha, 1)
  await fake.send('A 原会话已完成的问题')
  const question = panel(page).getByRole('textbox', { name: '向 Codex 提问', exact: true })
  await question.fill('A 尚未发送的追问草稿')
  await page.locator('.tab-actions').getByLabel('更多', { exact: true }).click()
  await page.getByRole('menuitem', { name: /^搜索/ }).click()
  await page.getByRole('searchbox', { name: '搜索文档', exact: true }).fill('position')
  await expect(page.locator('.search-count')).toContainText('1/5 页')
  await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue('1')
  await clickReadingControl(page, '适合宽度')
  await expect.poll(async () => {
    const paper = await page.locator('#page-1').boundingBox()
    const width = await page.locator('.document-scroll').evaluate(element => element.clientWidth)
    return Math.abs(paper!.width - (width - 40))
  }).toBeLessThan(2)
  await readAt(page, 3, 175)
  const before = await normalizedReadingPoint(page, 3)

  await activate(page, beta, 1)
  await fake.show()
  await expect(question).toHaveValue('')
  await question.fill('B 自己尚未发送的草稿')
  await page.setViewportSize({ width: 1920, height: 1100 })
  await expect.poll(() => page.locator('.reader-layout').evaluate(element => element.getBoundingClientRect().width)).toBe(1920)
  await activate(page, alpha, 3)
  await expect(question).toHaveValue('A 尚未发送的追问草稿')
  await expect(page.getByRole('searchbox', { name: '搜索文档', exact: true })).toHaveValue('position')
  // Wait for restored search results, so a delayed automatic jump to match 1
  // cannot slip past an assertion made immediately after changing the tab.
  await expect(page.locator('.search-count')).toContainText('1/5 页')
  await expect(page.getByRole('textbox', { name: '当前页码', exact: true })).toHaveValue('3')
  await expect.poll(async () => (await normalizedReadingPoint(page, 3)).width).toBeGreaterThan(before.width + 100)
  await expect.poll(async () => {
    const after = await normalizedReadingPoint(page, 3)
    return Math.max(Math.abs(after.x - before.x), Math.abs(after.y - before.y))
  }).toBeLessThan(0.004)

  await panel(page).getByRole('button', { name: '新建会话', exact: true }).click()
  await expect(question).toHaveValue('')
  await question.fill('新聊天里不应带回旧会话的草稿')
  await panel(page).getByRole('button', { name: '切换会话', exact: true }).click()
  await panel(page).getByRole('button', { name: '切换到会话：A 原会话已完成的问题', exact: true }).click()
  await expect(question).toHaveValue('')
  await expect(panel(page).locator('.codex-message.assistant')).toHaveCount(1)
  expect(fake.calls).toHaveLength(1)
  await activate(page, beta, 1)
  await expect(question).toHaveValue('B 自己尚未发送的草稿')
  await expect(page.getByRole('searchbox', { name: '搜索文档', exact: true })).toHaveCount(0)
})
