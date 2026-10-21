export interface CodexModel {
  id: string
  name: string
  description?: string
  reasoningLevels: { id: string; label: string }[]
  defaultReasoningLevel: string
}
export interface CodexModelCatalog { models: CodexModel[]; defaultModel: string }
export interface CodexPreferences { model: string; reasoningByModel: Record<string, string> }
export const CODEX_SETTINGS_KEY = 'folio-codex-settings-v1'

function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function storage(): Storage | null { try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null } }

export function parseCodexModelCatalog(value: unknown): CodexModelCatalog | null {
  if (!record(value) || !Array.isArray(value.models)) return null
  const models: CodexModel[] = []
  for (const candidate of value.models) {
    if (!record(candidate) || typeof candidate.id !== 'string' || !candidate.id.trim() || !Array.isArray(candidate.reasoningLevels) || models.some(model => model.id === candidate.id)) continue
    const reasoningLevels: CodexModel['reasoningLevels'] = []
    for (const level of candidate.reasoningLevels) {
      if (record(level) && typeof level.id === 'string' && level.id.trim() && !reasoningLevels.some(item => item.id === level.id)) {
        reasoningLevels.push({ id: level.id, label: typeof level.label === 'string' && level.label.trim() ? level.label : level.id })
      }
    }
    models.push({
      id: candidate.id,
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name : candidate.id,
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      reasoningLevels,
      defaultReasoningLevel: reasoningLevels.find(level => level.id === candidate.defaultReasoningLevel)?.id ?? reasoningLevels[0]?.id ?? '',
    })
  }
  if (!models.length) return null
  return { models, defaultModel: models.find(model => model.id === value.defaultModel)?.id ?? models[0].id }
}

export function readCodexPreferences(source: Pick<Storage, 'getItem'> | null = storage()): CodexPreferences {
  try {
    const value: unknown = JSON.parse(source?.getItem(CODEX_SETTINGS_KEY) ?? 'null')
    if (record(value)) return {
      model: typeof value.model === 'string' ? value.model : '',
      reasoningByModel: record(value.reasoningByModel) ? Object.fromEntries(Object.entries(value.reasoningByModel).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
    }
  } catch { /* Unavailable storage or old malformed settings must not block reading. */ }
  return { model: '', reasoningByModel: {} }
}

export function resolveCodexSelection(catalog: CodexModelCatalog, preferences: CodexPreferences) {
  const model = catalog.models.find(item => item.id === preferences.model) ?? catalog.models.find(item => item.id === catalog.defaultModel) ?? catalog.models[0]
  if (!model) return null
  const reasoningEffort = model.reasoningLevels.find(level => level.id === preferences.reasoningByModel[model.id])?.id
    ?? model.reasoningLevels.find(level => level.id === model.defaultReasoningLevel)?.id
    ?? model.reasoningLevels[0]?.id
  return { model, reasoningEffort }
}

export function normalizeCodexPreferences(catalog: CodexModelCatalog, preferences: CodexPreferences): CodexPreferences {
  const selected = resolveCodexSelection(catalog, preferences)
  if (!selected) return preferences
  const reasoningByModel = { ...preferences.reasoningByModel }
  if (selected.reasoningEffort) reasoningByModel[selected.model.id] = selected.reasoningEffort
  else delete reasoningByModel[selected.model.id]
  return { model: selected.model.id, reasoningByModel }
}

export function saveCodexPreferences(preferences: CodexPreferences, target: Pick<Storage, 'setItem'> | null = storage()): void {
  try { target?.setItem(CODEX_SETTINGS_KEY, JSON.stringify(preferences)) } catch { /* Keep working when the browser disallows local storage. */ }
}
