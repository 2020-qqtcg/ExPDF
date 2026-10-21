import { test, expect, type Locator, type Page } from '@playwright/test'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { selectTool, useFixedZoom } from './helpers/reader'

type Point = { x: number; y: number }
const sheet = (page: Page) => page.locator('#page-2')
const zoom = (page: Page) => page.getByRole('combobox', { name: '缩放比例', exact: true })

async function zoomPdfBytes(title = 'Wheel zoom paper') {
  const document = await PDFDocument.create()
  const font = await document.embedFont(StandardFonts.Helvetica)
  for (let number = 1; number <= 4; number++) {
    const paper = document.addPage([612, 792])
    paper.drawText(`${title} - page ${number}`, { x: 52, y: 725, size: 18, font })
    paper.drawText(`Reading anchor on page ${number}`, { x: 52, y: 380, size: 18, font })
    paper.drawText('The PDF changes size while the application stays at its native browser scale.', { x: 52, y: 180, size: 12, font })
  }
  return Buffer.from(await document.save())
}

async function openZoomPdf(page: Page, scale: string | null = '1') {
  let asks = 0
  await page.route('**/api/codex/status*', route => route.fulfill({ json: { available: true, loggedIn: true } }))
  await page.route('**/api/codex/models*', route => route.fulfill({ json: {
    defaultModel: 'zoom-test',
    models: [{ id: 'zoom-test', name: 'Zoom test model', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' }],
  } }))
  await page.route('**/api/codex/ask', route => { asks++; return route.fulfill({ status: 500, json: { error: 'Unexpected question while testing zoom' } }) })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await expect(page.locator('#page-1 .textLayer span').first()).toBeVisible()
  await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'reader-wheel-zoom.pdf', mimeType: 'application/pdf', buffer: await zoomPdfBytes() })
  await expect(page.locator('#page-1 .textLayer')).toContainText('Wheel zoom paper')
  if (scale !== null) await useFixedZoom(page, scale)
  else await expect.poll(async () => {
    const fit = await page.locator('.document-scroll').evaluate(element => (element.clientWidth - 40) / 612)
    return Math.abs(await pdfScale(page) - fit)
  }).toBeLessThan(0.001)
  await zoom(page).blur()
  await page.locator('.document-scroll').evaluate(element => {
    const second = document.getElementById('page-2')!
    element.scrollTop = second.offsetTop + 200
    element.scrollLeft = Math.max(0, (element.scrollWidth - element.clientWidth) / 2)
  })
  await expect(sheet(page).locator('.textLayer')).toContainText('Reading anchor on page 2')
  return () => asks
}

async function pdfScale(page: Page) {
  return sheet(page).evaluate(element => element.getBoundingClientRect().width / 612)
}

async function expectScale(page: Page, expected: number) {
  await expect.poll(async () => Math.abs(await pdfScale(page) - expected)).toBeLessThan(0.001)
  await expect.poll(async () => Math.abs(Number(await zoom(page).inputValue()) - expected)).toBeLessThan(0.001)
}

async function mouseAnchor(page: Page): Promise<Point> {
  return page.locator('.document-scroll').evaluate(element => {
    const box = element.getBoundingClientRect()
    // Deliberately use the right half to catch accidental centre anchoring.
    return { x: box.left + element.clientWidth * 0.72, y: box.top + element.clientHeight * 0.42 }
  })
}

async function pdfPointAt(page: Page, point: Point) {
  return sheet(page).evaluate((element, position) => {
    const box = element.getBoundingClientRect()
    return { x: (position.x - box.left) / box.width, y: (position.y - box.top) / box.height, width: box.width, height: box.height }
  }, point)
}

async function browserScale(page: Page) {
  return page.evaluate(() => ({ dpr: devicePixelRatio, viewportScale: visualViewport?.scale, width: innerWidth, height: innerHeight }))
}

async function settledFrames(page: Page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function controlWheel(page: Page, delta: number) {
  await page.keyboard.down('Control')
  try { await page.mouse.wheel(0, delta) } finally { await page.keyboard.up('Control') }
}

async function wheelEvents(target: Locator, deltas: number[], point: Point, mode = 0) {
  return target.evaluate((element, eventData) => eventData.deltas.map(deltaY => {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY, deltaMode: eventData.mode, clientX: eventData.point.x, clientY: eventData.point.y })
    element.dispatchEvent(event)
    return event.defaultPrevented
  }), { deltas, point, mode })
}

test('zooms with real Control-wheel around the pointer, keeps ordinary wheel scrolling, and leaves the browser scale unchanged', async ({ page }) => {
  const asks = await openZoomPdf(page, '2.5')
  const point = await mouseAnchor(page)
  const originalPoint = await pdfPointAt(page, point)
  const originalBrowser = await browserScale(page)
  await page.mouse.move(point.x, point.y)
  for (const [delta, expected] of [[-100, 2.75], [100, 2.5]] as const) {
    await controlWheel(page, delta)
    await expectScale(page, expected)
    await expect.poll(async () => {
      const current = await pdfPointAt(page, point)
      return Math.hypot((current.x - originalPoint.x) * current.width, (current.y - originalPoint.y) * current.height)
    }).toBeLessThan(2)
    expect(await browserScale(page)).toEqual(originalBrowser)
  }
  const before = await page.locator('.document-scroll').evaluate(element => element.scrollTop)
  await page.mouse.wheel(0, 300)
  await expect.poll(() => page.locator('.document-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(before + 200)
  await expectScale(page, 2.5)
  expect(await browserScale(page)).toEqual(originalBrowser)
  expect(asks()).toBe(0)
})

test('accumulates pinch bursts before rendering, clamps each delta, and prevents native zoom even at the PDF limits', async ({ page }) => {
  const asks = await openZoomPdf(page)
  const point = await mouseAnchor(page)
  const originalBrowser = await browserScale(page)
  // No physical Control key is pressed: this is Chromium's trackpad-pinch wheel shape.
  // Dispatch in one browser task so every delta precedes the next animation frame.
  expect(await wheelEvents(sheet(page), Array(30).fill(-1), point)).toEqual(Array(30).fill(true))
  await expectScale(page, Math.exp(0.3))
  await useFixedZoom(page)
  await zoom(page).blur()
  expect(await wheelEvents(sheet(page), [-200, -200, 100], point)).toEqual([true, true, true])
  await expectScale(page, 5 / Math.E)
  expect(await wheelEvents(sheet(page), [-10_000], point)).toEqual([true])
  await expectScale(page, 5)
  expect(await wheelEvents(sheet(page), [-1], point)).toEqual([true])
  await page.mouse.move(point.x, point.y)
  await controlWheel(page, -100)
  await settledFrames(page)
  await expectScale(page, 5)
  expect(await browserScale(page)).toEqual(originalBrowser)
  await page.locator('.document-scroll').evaluate(element => { element.scrollTop += 180 })
  const scrolled = await page.locator('.document-scroll').evaluate(element => element.scrollTop)
  await page.keyboard.press('Escape')
  await settledFrames(page)
  expect(await page.locator('.document-scroll').evaluate(element => element.scrollTop)).toBeCloseTo(scrolled, 0)
  expect(await wheelEvents(sheet(page), [10_000], point)).toEqual([true])
  await expectScale(page, 0.35)
  expect(await wheelEvents(sheet(page), [1], point)).toEqual([true])
  await controlWheel(page, 100)
  await settledFrames(page)
  await expectScale(page, 0.35)
  expect(await browserScale(page)).toEqual(originalBrowser)
  await useFixedZoom(page)
  await zoom(page).blur()
  expect(await wheelEvents(sheet(page), [-1], point, 1)).toEqual([true])
  await expectScale(page, 1.1)
  expect(await wheelEvents(sheet(page), [1], point, 2)).toEqual([true])
  await expectScale(page, 1)
  expect(await browserScale(page)).toEqual(originalBrowser)
  expect(asks()).toBe(0)
})

test('ignores Control-wheel over Codex and form inputs, including the PDF inline text editor', async ({ page }) => {
  const asks = await openZoomPdf(page)
  await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
  const before = await pdfScale(page)
  const targets = [
    page.locator('.codex-conversation'),
    page.getByRole('textbox', { name: '向 Codex 提问', exact: true }),
    page.getByRole('textbox', { name: '当前页码', exact: true }),
    zoom(page),
  ]
  for (const target of targets) {
    const box = await target.boundingBox()
    expect(box).not.toBeNull()
    expect(await wheelEvents(target, [-100], { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 })).toEqual([false])
    await settledFrames(page)
    await expectScale(page, before)
  }
  await selectTool(page, '添加文字')
  // This tool loads its font asynchronously before activating the page editor.
  await expect(page.locator('.tool-list').getByRole('button', { name: '添加文字', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.text-format-bar')).toBeVisible()
  await sheet(page).click({ position: { x: 100, y: 400 } })
  const editor = page.getByRole('textbox', { name: '页面文字', exact: true })
  await expect(editor).toBeVisible()
  await editor.fill('缩放手势不应改变输入中的文字。')
  const box = await editor.boundingBox()
  expect(await wheelEvents(editor, [-100], { x: box!.x + 5, y: box!.y + 5 })).toEqual([false])
  await settledFrames(page)
  await expectScale(page, before)
  await expect(editor).toHaveValue('缩放手势不应改变输入中的文字。')
  await editor.press('Escape')
  expect(asks()).toBe(0)
})

test('lets a pinch take precedence over an already queued automatic fit and keeps the resulting manual scale through sidebar changes', async ({ page }) => {
  const asks = await openZoomPdf(page, null)
  const initial = await pdfScale(page)
  const point = await mouseAnchor(page)
  const result = await page.locator('.document-scroll').evaluate((element, position) => new Promise<{ prevented: boolean; scaleBefore: number }>(resolve => {
    // App's ResizeObserver was registered first. It queues its automatic refit;
    // this observer sends the gesture before that queued animation frame runs.
    const observer = new ResizeObserver(() => {
      observer.disconnect()
      const scaleBefore = document.getElementById('page-2')!.getBoundingClientRect().width / 612
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -8, clientX: position.x, clientY: position.y })
      element.dispatchEvent(event)
      resolve({ prevented: event.defaultPrevented, scaleBefore })
    })
    observer.observe(element)
    ;(element as HTMLElement).style.width = `${element.getBoundingClientRect().width - 120}px`
  }), point)
  expect(result.prevented).toBe(true)
  expect(result.scaleBefore).toBeCloseTo(initial, 3)
  const manual = initial * Math.exp(0.08)
  await expectScale(page, manual)
  await page.locator('.document-scroll').evaluate(element => { (element as HTMLElement).style.removeProperty('width') })
  await settledFrames(page)
  await expectScale(page, manual)
  await page.locator('.annotation-tools').getByRole('button', { name: 'Codex AI', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Codex 模型', exact: true })).toBeEnabled()
  await settledFrames(page)
  await expectScale(page, manual)
  await page.getByRole('button', { name: '关闭 Codex 侧栏', exact: true }).click()
  await settledFrames(page)
  await expectScale(page, manual)
  expect(asks()).toBe(0)
})

test('continues treating a held Control key as a wheel modifier after opening another PDF', async ({ page }) => {
  const asks = await openZoomPdf(page)
  const originalBrowser = await browserScale(page)
  await page.keyboard.down('Control')
  try {
    await page.getByLabel('选择 PDF 文件').setInputFiles({ name: 'switched-wheel-zoom.pdf', mimeType: 'application/pdf', buffer: await zoomPdfBytes('Switched zoom paper') })
    await expect(page.locator('#page-1 .textLayer')).toContainText('Switched zoom paper')
    await useFixedZoom(page)
    await zoom(page).blur()
    await page.locator('.document-scroll').evaluate(element => {
      element.scrollTop = document.getElementById('page-2')!.offsetTop + 200
    })
    await expect(sheet(page).locator('.textLayer')).toContainText('Switched zoom paper')
    const point = await mouseAnchor(page)
    await page.mouse.move(point.x, point.y)
    // No second keydown occurs: a document-scoped listener would misread this as a pinch.
    await page.mouse.wheel(0, -100)
    await expectScale(page, 1.1)
    expect(await browserScale(page)).toEqual(originalBrowser)
  } finally { await page.keyboard.up('Control') }
  expect(asks()).toBe(0)
})
