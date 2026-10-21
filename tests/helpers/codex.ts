import { expect, type Page } from '@playwright/test'

export type CodexSetting = 'Codex 模型' | '思考深度'

export async function chooseCodexOption(page: Page, setting: CodexSetting, label: string) {
  const trigger = page.getByRole('combobox', { name: setting, exact: true })
  await trigger.click()
  const list = page.getByRole('listbox', { name: setting, exact: true })
  await expect(list).toBeVisible()
  await list.getByRole('option', { name: label, exact: true }).click()
  await expect(list).toHaveCount(0)
  await expect(trigger).toContainText(label)
}
