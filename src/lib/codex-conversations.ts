import type { CodexConversation, CodexMessage, DocumentSession } from '../types'

export type CodexConversationSession = Partial<Pick<DocumentSession, 'codexConversations' | 'activeCodexConversationId' | 'codexMessages' | 'codexThreadId' | 'updatedAt'>>

function conversationTitle(messages: CodexMessage[]) {
  const question = messages.find(message => message.role === 'user' && message.content.trim())?.content
  return question ? Array.from(question.replace(/\s+/gu, ' ').trim()).slice(0, 28).join('') : '新会话'
}

export function createCodexConversation(): CodexConversation {
  const now = Date.now()
  return { id: crypto.randomUUID(), title: '新会话', messages: [], createdAt: now, updatedAt: now }
}

export function restoreCodexConversations(session?: CodexConversationSession): { conversations: CodexConversation[]; activeId: string } {
  const timestamp = Number.isFinite(session?.updatedAt) ? session!.updatedAt! : Date.now()
  const seen = new Set<string>()
  const conversations = (session?.codexConversations ?? []).filter(conversation => {
    if (!conversation?.id?.trim() || !Array.isArray(conversation.messages) || seen.has(conversation.id)) return false
    seen.add(conversation.id)
    return true
  }).map(conversation => ({
    ...conversation,
    title: conversation.title?.trim() || conversationTitle(conversation.messages),
    messages: [...conversation.messages],
    createdAt: Number.isFinite(conversation.createdAt) ? conversation.createdAt : timestamp,
    updatedAt: Number.isFinite(conversation.updatedAt) ? conversation.updatedAt : timestamp,
  }))
  if (!conversations.length) {
    const messages = [...(session?.codexMessages ?? [])]
    conversations.push({ id: 'legacy', title: conversationTitle(messages), messages, ...(session?.codexThreadId ? { threadId: session.codexThreadId } : {}), createdAt: timestamp, updatedAt: timestamp })
  }
  const active = conversations.find(conversation => conversation.id === session?.activeCodexConversationId)
    ?? conversations.reduce((latest, conversation) => conversation.updatedAt > latest.updatedAt ? conversation : latest)
  return { conversations, activeId: active.id }
}

export function updateCodexConversationMessages(conversation: CodexConversation, nextMessages: CodexMessage[]): CodexConversation {
  return { ...conversation, title: conversationTitle(nextMessages), messages: [...nextMessages], updatedAt: Date.now() }
}
