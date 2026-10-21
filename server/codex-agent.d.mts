import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
export interface CodexAgentOptions { executable?: string; workspaceRoot?: string; timeoutMs?: number; rpcTimeoutMs?: number }
export interface CodexAgentStatus {
  available: boolean
  desktopControl: false
  message?: string
  capabilities: { id: string; label: string; enabled: boolean; detail?: string }[]
  mcpServers: { name: string; status: string; toolCount?: number }[]
  skills: { name: string; enabled: boolean }[]
  workspaceRoot: string
  warnings?: string[]
}
export interface CodexAgentRuntime {
  middleware(request: IncomingMessage, response: ServerResponse, next: () => unknown): Promise<unknown>
  close(): Promise<void>
  probe(refresh?: boolean): Promise<CodexAgentStatus>
}
export function localAgentRequest(request: IncomingMessage): boolean
export function createCodexAgentRuntime(options?: CodexAgentOptions): CodexAgentRuntime
export default function codexAgentPlugin(options?: CodexAgentOptions): Plugin & { close(): Promise<void> }
