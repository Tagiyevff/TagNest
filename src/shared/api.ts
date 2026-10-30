import type {
  AgentEvent,
  ApprovalRequest,
  AppSnapshot,
  AutoUpdateState,
  Conversation,
  ConversationSummary,
  DiagnosticsResult,
  GuestStats,
  ProviderId,
  ProviderModelsResult,
  ProviderTestResult,
  RemoteAccessState,
  RemoteMode,
  RuntimeState,
  SettingsView,
  SetupStatus,
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
    installQemu: () => Promise<RuntimeState>
    checkpoint: () => Promise<RuntimeState>
    rollbackCheckpoint: () => Promise<RuntimeState>
    keepCheckpoint: () => Promise<RuntimeState>
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
  setup: {
    status: () => Promise<SetupStatus>
  }
  provider: {
    test: () => Promise<ProviderTestResult>
    models: () => Promise<ProviderModelsResult>
  }
  remote: {
    getState: () => Promise<RemoteAccessState>
    enable: (input: { mode: RemoteMode; customUrl?: string }) => Promise<RemoteAccessState>
    disable: () => Promise<RemoteAccessState>
    regenerateCode: () => Promise<RemoteAccessState>
    revokeDevice: (id: string) => Promise<RemoteAccessState>
  }
  app: {
    checkUpdates: () => Promise<UpdateInfo>
    diagnostics: () => Promise<DiagnosticsResult>
  }
  updates: {
    state: () => Promise<AutoUpdateState>
    check: () => Promise<AutoUpdateState>
    install: () => Promise<{ ok: true }>
  }
  onRuntimeState: (listener: (state: RuntimeState) => void) => () => void
  onAgentEvent: (listener: (event: AgentEvent) => void) => () => void
  onSettings: (listener: (settings: SettingsView) => void) => () => void
  onUpdateState: (listener: (state: AutoUpdateState) => void) => () => void
  onRemoteState: (listener: (state: RemoteAccessState) => void) => () => void
  onApprovalRequest?: (listener: (request: ApprovalRequest) => void) => () => void
}
