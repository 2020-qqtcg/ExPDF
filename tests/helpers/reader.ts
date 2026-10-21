import { expect, type Page } from '@playwright/test'

export type ToolLabel = '选择文本' | '拖动阅读' | '高亮' | '下划线' | '删除线' | '便签' | '自由绘制' | '添加文字'

/** Follow the visible toolbar or its real dropdown, rather than clicking hidden controls. */
export async function selectTool(page: Page, name: ToolLabel) {
  const direct = page.locator('.tool-list').getByRole('button', { name, exact: true })
  if (await direct.isVisible()) {
    await direct.click()
    return
  }
  const group = ['高亮', '下划线', '删除线'].includes(name)
    ? { trigger: '高亮与划线选项', menu: '高亮与划线' }
    : ['选择文本', '拖动阅读'].includes(name)
      ? { trigger: '选择工具选项', menu: '选择工具' }
      : undefined
  if (group && await page.getByRole('button', { name: group.trigger, exact: true }).isVisible()) {
    await page.getByRole('button', { name: group.trigger, exact: true }).click()
    await page.getByRole('menu', { name: group.menu, exact: true }).getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click()
    return
  }
  throw new Error(`The persistent annotation toolbar does not expose ${name}`)
}

export async function showAnnotations(page: Page) {
  if (!await page.locator('.annotations-panel').isVisible()) await page.getByRole('button', { name: '查看标注', exact: true }).click()
  await expect(page.locator('.annotations-panel')).toBeVisible()
}

/** Coordinate fixtures use native PDF points; the product otherwise defaults to fit width. */
export async function useFixedZoom(page: Page, scale = '1') {
  await wakeReadingControls(page)
  const zoom = page.getByRole('combobox', { name: '缩放比例', exact: true })
  await zoom.selectOption(scale)
  await expect(zoom).toHaveValue(scale)
}

export async function wakeReadingControls(page: Page) {
  const box = await page.locator('.floating-controls').boundingBox()
  expect(box).not.toBeNull()
  // Real pointer movement wakes the intentionally idle controls before click hit-testing.
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
}

export async function clickReadingControl(page: Page, name: string) {
  await wakeReadingControls(page)
  await page.getByRole('button', { name, exact: true }).click()
}

export async function openFileMenu(page: Page) {
  if (!await page.getByRole('menu', { name: '更多操作', exact: true }).isVisible()) await page.locator('.tab-actions').getByLabel('更多', { exact: true }).click()
  return page.getByRole('menuitem', { name: '打开文件', exact: true })
}

export async function fileAction(page: Page, name: string) {
  await openFileMenu(page)
  return page.getByRole('menu', { name: '更多操作', exact: true }).getByRole('menuitem', { name, exact: true })
}

export async function clickFileAction(page: Page, name: string) {
  await (await fileAction(page, name)).click()
}

export async function closeFileMenu(page: Page) {
  if (await page.getByRole('menu', { name: '更多操作', exact: true }).isVisible()) await page.locator('.tab-actions').getByLabel('更多', { exact: true }).click()
}
