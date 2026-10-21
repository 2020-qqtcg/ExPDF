import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodexConversation, restoreCodexConversations, updateCodexConversationMessages } from '../src/lib/codex-conversations.ts'
import type { CodexConversation, CodexMessage } from '../src/types.ts'

const messages: CodexMessage[] = [{ id: 'question', role: 'user', content: '请\n  整理这篇论文的主要结论。' }, { id: 'answer', role: 'assistant', content: '保留原回答和执行记录。', activities: [{ id: 'read', kind: 'tool', title: '读取PDF', status: 'completed' }] }]
const conversation = (id: string, updatedAt: number): CodexConversation => ({ id, title: `会话 ${id}`, messages: [...messages], threadId: `thread-${id}`, createdAt: 100, updatedAt })

test('creates independent empty conversations with UUID identity and matching initial timestamps', () => {
  const first = createCodexConversation(), second = createCodexConversation()
  assert.match(first.id, /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i)
  assert.notEqual(first.id, second.id)
  assert.equal(first.title, '新会话')
  assert.deepEqual(first.messages, [])
  assert.equal(first.threadId, undefined)
  assert.equal(first.createdAt, first.updatedAt)
  first.messages.push(messages[0])
  assert.deepEqual(second.messages, [])
})

test('migrates legacy messages and CLI thread together without modifying the stored history', () => {
  const restored = restoreCodexConversations({ codexMessages: messages, codexThreadId: 'legacy-thread', updatedAt: 1234 })
  assert.equal(restored.activeId, 'legacy')
  assert.equal(restored.conversations.length, 1)
  const legacy = restored.conversations[0]
  assert.equal(legacy.id, 'legacy')
  assert.equal(legacy.threadId, 'legacy-thread')
  assert.equal(legacy.title, '请 整理这篇论文的主要结论。')
  assert.deepEqual(legacy.messages, messages)
  assert.notEqual(legacy.messages, messages)
  assert.equal(legacy.createdAt, 1234)
  assert.equal(legacy.updatedAt, 1234)
  assert.deepEqual(restoreCodexConversations({ codexThreadId: 'thread-only', updatedAt: 7 }).conversations[0].messages, [])
})

test('creates a stable legacy empty session when there is no history, including old empty arrays', () => {
  for (const input of [undefined, {}, { codexMessages: [], codexConversations: [] }]) {
    const restored = restoreCodexConversations(input)
    assert.equal(restored.activeId, 'legacy')
    assert.equal(restored.conversations.length, 1)
    assert.equal(restored.conversations[0].title, '新会话')
    assert.deepEqual(restored.conversations[0].messages, [])
  }
})

test('restores serialized new conversations in order, preferring them over legacy mirrors', () => {
  const original = { codexConversations: [conversation('old', 200), conversation('recent', 400)], activeCodexConversationId: 'old', codexMessages: [{ id: 'mirror', role: 'user' as const, content: '不应再次迁入旧镜像。' }], codexThreadId: 'mirror-thread', updatedAt: 500 }
  const restored = restoreCodexConversations(JSON.parse(JSON.stringify(original)))
  assert.deepEqual(restored.conversations, original.codexConversations)
  assert.equal(restored.activeId, 'old', 'a valid explicitly active session wins over the most recent one')
  assert.equal(restored.conversations.length, 2)
  assert(!restored.conversations.some(item => item.id === 'legacy'))
  assert.equal(restoreCodexConversations({ ...original, activeCodexConversationId: 'missing' }).activeId, 'recent')
  assert.equal(restoreCodexConversations({ codexConversations: [conversation('first', 400), conversation('second', 400)] }).activeId, 'first')
})

test('updates the first-question title without splitting Unicode or changing thread and earlier snapshots', () => {
  const original = { ...conversation('existing', 200), messages: [] }
  const content = `  ${'😀'.repeat(30)}\n后续文字 `
  const nextMessages: CodexMessage[] = [{ id: 'first', role: 'user', content }, { id: 'second', role: 'user', content: '后续问题不应替代首问标题。' }]
  const updated = updateCodexConversationMessages(original, nextMessages)
  assert.equal(updated.title, '😀'.repeat(28))
  assert.equal(Array.from(updated.title).length, 28)
  assert.equal(updated.threadId, original.threadId)
  assert.equal(updated.id, original.id)
  assert.equal(updated.createdAt, original.createdAt)
  assert(updated.updatedAt >= original.updatedAt)
  assert.deepEqual(original.messages, [])
  assert.notEqual(updated.messages, nextMessages)
  assert.equal(updateCodexConversationMessages(updated, [{ id: 'system-answer', role: 'assistant', content: '没有首问。' }]).title, '新会话')
})
