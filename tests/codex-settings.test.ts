import assert from 'node:assert/strict'
import test from 'node:test'
import { CODEX_SETTINGS_KEY, normalizeCodexPreferences, parseCodexModelCatalog, readCodexPreferences, resolveCodexSelection, saveCodexPreferences } from '../src/lib/codex-settings.ts'

const catalog = parseCodexModelCatalog({
  defaultModel: 'alpha',
  models: [
    { id: 'alpha', name: 'Alpha', reasoningLevels: [{ id: 'low', label: '轻度' }, { id: 'high', label: '深入' }], defaultReasoningLevel: 'low' },
    { id: 'beta', name: 'Beta', reasoningLevels: [{ id: 'medium', label: '标准' }], defaultReasoningLevel: 'medium' },
    { id: 'gamma', name: 'Gamma', reasoningLevels: [], defaultReasoningLevel: '' },
  ],
})!

test('restores each model effort and repairs unsupported saved model/effort values', () => {
  const alpha = { model: 'alpha', reasoningByModel: { alpha: 'high', beta: 'unsupported' } }
  const beta = normalizeCodexPreferences(catalog, { ...alpha, model: 'beta' })
  assert.deepEqual(resolveCodexSelection(catalog, beta), { model: catalog.models[1], reasoningEffort: 'medium' })
  const restored = normalizeCodexPreferences(catalog, { ...beta, model: 'alpha' })
  assert.equal(resolveCodexSelection(catalog, restored)?.reasoningEffort, 'high')
  const repaired = normalizeCodexPreferences(catalog, { model: 'removed-model', reasoningByModel: { alpha: 'obsolete' } })
  assert.equal(repaired.model, 'alpha')
  assert.equal(repaired.reasoningByModel.alpha, 'low')
  const noReasoning = normalizeCodexPreferences(catalog, { model: 'gamma', reasoningByModel: { gamma: 'high' } })
  assert.equal(resolveCodexSelection(catalog, noReasoning)?.reasoningEffort, undefined)
  assert.equal(noReasoning.reasoningByModel.gamma, undefined)
})

test('catalog defaults and supported controls come from validated server capabilities', () => {
  assert.equal(parseCodexModelCatalog({ models: [] }), null)
  assert.equal(parseCodexModelCatalog('invalid'), null)
  const parsed = parseCodexModelCatalog({ defaultModel: 'missing', models: [
    { id: 'server-model', reasoningLevels: [{ id: 'server-level', label: '自定义深度' }, { id: 'server-level' }, null], defaultReasoningLevel: 'unsupported' },
    { id: 'server-model', reasoningLevels: [] },
    { id: 'invalid-without-capabilities' },
  ] })!
  assert.equal(parsed.defaultModel, 'server-model')
  assert.equal(parsed.models.length, 1)
  assert.deepEqual(parsed.models[0].reasoningLevels, [{ id: 'server-level', label: '自定义深度' }])
  assert.equal(parsed.models[0].defaultReasoningLevel, 'server-level')
})

test('preferences survive reload while malformed or blocked storage remains usable', () => {
  const values = new Map<string, string>()
  const local = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  const preferences = { model: 'alpha', reasoningByModel: { alpha: 'high' } }
  saveCodexPreferences(preferences, local)
  assert.deepEqual(readCodexPreferences(local), preferences)
  values.set(CODEX_SETTINGS_KEY, '{broken')
  assert.deepEqual(readCodexPreferences(local), { model: '', reasoningByModel: {} })
  values.set(CODEX_SETTINGS_KEY, JSON.stringify({ model: 'alpha', reasoningByModel: { alpha: 'high', invalid: 3 } }))
  assert.deepEqual(readCodexPreferences(local), preferences)
  assert.doesNotThrow(() => saveCodexPreferences(preferences, { setItem() { throw new Error('denied') } }))
  assert.deepEqual(readCodexPreferences({ getItem() { throw new Error('denied') } }), { model: '', reasoningByModel: {} })
})
