import type {
  AgentEvent,
  ApprovalRequest,
  AppSnapshot,
  Conversation,
  ConversationSummary,
  GuestStats,
  ProviderId,
  ProviderTestResult,
  RuntimeState,
  UpdateInfo,
  WorkspaceDownloadResult,
  WorkspaceListing,
  WorkspaceTransfer
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
    stats: () => Promise<GuestStats | null>
  }
  files: {
    list: (path?: string) => Promise<WorkspaceListing>
    upload: (input: {
      files?: Array<{ name: string; relativePath?: string; data: Uint8Array }>
      hostPaths?: string[]
      pick?: boolean
    }) => Promise<WorkspaceTransfer>
    download: (path: string) => Promise<WorkspaceDownloadResult>
  }
  provider: {
    test: () => Promise<ProviderTestResult>
  }
  app: {
    checkUpdates: () => Promise<UpdateInfo>
  }
  onRuntimeState: (listener: (state: RuntimeState) => void) => () => void
  onAgentEvent: (listener: (event: AgentEvent) => void) => () => void
  onApprovalRequest?: (listener: (request: ApprovalRequest) => void) => () => void
}
