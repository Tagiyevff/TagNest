import type {
  AgentEvent,
  ApprovalRequest,
  AppSnapshot,
  Conversation,
  ConversationSummary,
  ProviderId,
  RuntimeState
} from './types'
import type { SettingsPatch } from './ipc'

export interface RuntimeLogs {
  logPath?: string
  tail: string
}

export interface TagNestApi {
  getState: () => Promise<AppSnapshot>
  updateSettings: (patch: SettingsPatch) => Promise<AppSnapshot>
  setApiKey: (provider: ProviderId, apiKey: string) => Promise<AppSnapshot>
  clearApiKey: (provider: ProviderId) => Promise<AppSnapshot>
  conversations: {
    list: () => Promise<ConversationSummary[]>
    get: (id: string) => Promise<Conversation | null>
    create: () => Promise<Conversation>
    delete: (id: string) => Promise<{ deleted: boolean }>
    setActive: (id: string | null) => Promise<{ ok: true }>
  }
  agent: {
    send: (input: { conversationId?: string; text: string }) => Promise<{ conversationId: string }>
    cancel: () => Promise<{ ok: true }>
    approve: (requestId: string, approved: boolean) => Promise<{ ok: true }>
    retry: (conversationId: string) => Promise<{ ok: true }>
  }
  runtime: {
    getState: () => Promise<RuntimeState>
    start: () => Promise<RuntimeState>
    stop: () => Promise<RuntimeState>
    restart: () => Promise<RuntimeState>
    logs: () => Promise<RuntimeLogs>
    openLogFolder: () => Promise<{ ok: boolean }>
  }
  onRuntimeState: (listener: (state: RuntimeState) => void) => () => void
  onAgentEvent: (listener: (event: AgentEvent) => void) => () => void
  onApprovalRequest?: (listener: (request: ApprovalRequest) => void) => () => void
}
