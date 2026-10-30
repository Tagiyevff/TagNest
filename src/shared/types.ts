/**
 * Shared, renderer-safe types for TagNest.
 *
 * Nothing in this module may import Node.js or Electron APIs: it is bundled
 * into both the main process and the sandboxed renderer.
 */

export type Language = 'en' | 'az'

export type ProviderId = 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'ollama' | 'custom'

/**
 * `free-auto` is only meaningful for OpenRouter: the app resolves a currently
 * free model from OpenRouter's real model list instead of using a fixed ID.
 */
export type ModelMode = 'manual' | 'free-auto'

export type PrivacyMode = 'remote' | 'local'

export interface ProviderInfo {
  id: ProviderId
  label: string
  defaultModel: string
  defaultBaseUrl: string
  requiresApiKey: boolean
  supportsBaseUrl: boolean
  privacy: PrivacyMode
  docsUrl: string
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    defaultModel: 'gpt-4.1-mini',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    supportsBaseUrl: false,
    privacy: 'remote',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat'
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    defaultModel: 'claude-sonnet-4-20250514',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    supportsBaseUrl: false,
    privacy: 'remote',
    docsUrl: 'https://docs.anthropic.com/en/api/messages'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    defaultModel: 'gemini-2.5-flash',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    requiresApiKey: true,
    supportsBaseUrl: false,
    privacy: 'remote',
    docsUrl: 'https://ai.google.dev/gemini-api/docs'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    defaultModel: 'openai/gpt-4.1-mini',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    supportsBaseUrl: false,
    privacy: 'remote',
    docsUrl: 'https://openrouter.ai/docs/api-reference/overview'
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    defaultModel: 'qwen2.5-coder:7b',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false,
    supportsBaseUrl: true,
    privacy: 'local',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md'
  },
  {
    id: 'custom',
    label: 'OpenAI-compatible',
    defaultModel: '',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    requiresApiKey: false,
    supportsBaseUrl: true,
    privacy: 'local',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat'
  }
]

export interface AppSettings {
  provider: ProviderId
  model: string
  modelMode: ModelMode
  baseUrl: string
  language: Language
  memoryMB: number
  cpus: number
  diskGB: number
  autoStartLinux: boolean
  approveSafeCommands: boolean
}

export interface SettingsView extends AppSettings {
  hasApiKey: boolean
  providers: ProviderInfo[]
}

export type RuntimePhase =
  | 'stopped'
  | 'preparing'
  | 'downloading-image'
  | 'creating-disk'
  | 'starting'
  | 'provisioning'
  | 'connecting'
  | 'running'
  | 'stopping'
  | 'error'

export type Acceleration = 'whpx' | 'tcg' | 'unknown'

export interface RuntimeErrorInfo {
  message: string
  hint?: string
  detail?: string
}

export interface RuntimeState {
  phase: RuntimePhase
  message: string
  detail?: string
  progress?: number
  acceleration: Acceleration
  warning?: string
  error?: RuntimeErrorInfo
  /** Authenticated WebSocket URL for the embedded VNC display. */
  vncUrl?: string
  sshPort?: number
  startedAt?: number
  logPath?: string
  memoryMB: number
  cpus: number
  /** Whether the QEMU emulator was found on this computer. */
  qemuFound: boolean
  /** True when the app can install QEMU itself (Windows + winget). */
  qemuCanInstall: boolean
  qemuInstalling: boolean
  qemuInstallMessage?: string
}

export type ToolCallState = 'running' | 'awaiting-approval' | 'ok' | 'error' | 'denied' | 'cancelled'

export interface DesktopPointer {
  x: number
  y: number
  kind: 'click' | 'move' | 'type' | 'key'
}

export interface ToolCallView {
  id: string
  name: string
  title: string
  summary?: string
  command?: string
  state: ToolCallState
  output?: string
  exitCode?: number
  startedAt: number
  finishedAt?: number
  pointer?: DesktopPointer
}

export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  createdAt: number
  toolCalls: ToolCallView[]
  error?: string
  cancelled?: boolean
  model?: string
}

export interface Conversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: ChatMessage[]
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messageCount: number
}

export interface ApprovalRequest {
  id: string
  toolName: string
  title: string
  command?: string
  reason: string
  requestedAt: number
}

export type TaskStatus =
  | 'idle'
  | 'planning'
  | 'running'
  | 'waiting-approval'
  | 'cancelling'
  | 'done'
  | 'error'
  | 'cancelled'

export interface TaskState {
  conversationId: string | null
  status: TaskStatus
  activity?: string
  model?: string
  startedAt?: number
}

export type AgentEvent =
  | { type: 'conversation'; conversation: Conversation }
  | { type: 'message-added'; conversationId: string; message: ChatMessage }
  | { type: 'message-updated'; conversationId: string; message: ChatMessage }
  | { type: 'task-state'; task: TaskState }
  | { type: 'approval-request'; request: ApprovalRequest }
  | { type: 'approval-resolved'; requestId: string; approved: boolean }
  | { type: 'notice'; level: 'info' | 'error'; message: string }

export interface AppSnapshot {
  version: string
  settings: SettingsView
  runtime: RuntimeState
  conversations: ConversationSummary[]
  activeConversationId: string | null
  task: TaskState
}

export type WorkspaceEntryType = 'file' | 'directory' | 'symlink' | 'other'

export interface WorkspaceEntry {
  name: string
  path: string
  relative: string
  type: WorkspaceEntryType
  size: number
  modified: number
}

export interface WorkspaceListing {
  path: string
  relative: string
  parent: string | null
  entries: WorkspaceEntry[]
  truncated: boolean
}

/** One file sent from the renderer (drag & drop) into the guest workspace. */
export interface WorkspaceUploadFile {
  name: string
  relativePath?: string
  data: Uint8Array
}

export interface WorkspaceTransferFile {
  name: string
  ok: boolean
  path?: string
  error?: string
}

export interface WorkspaceTransfer {
  uploaded: number
  skipped: number
  bytes: number
  canceled?: boolean
  files: WorkspaceTransferFile[]
}

export interface WorkspaceDownloadResult {
  ok: boolean
  canceled?: boolean
  path?: string
  error?: string
}

export interface GuestStats {
  memoryUsedMB: number
  memoryTotalMB: number
  diskUsedGB: number
  diskTotalGB: number
  load1: number
  cpus: number
  uptimeSeconds: number
}

export interface ProviderTestResult {
  ok: boolean
  message: string
  latencyMs?: number
  model?: string
  reply?: string
}

/** One model returned by a provider's own model-listing endpoint. */
export interface ModelOption {
  id: string
  name: string
  description?: string
  contextLength?: number
  inputTokenLimit?: number
  outputTokenLimit?: number
  capabilities?: string[]
  free?: boolean
}

export interface ModelCatalog {
  provider: ProviderId
  models: ModelOption[]
  freeModels: ModelOption[]
  fetchedAt: number
  source: string
}

export interface ProviderModelsResult {
  ok: boolean
  provider: ProviderId
  catalog?: ModelCatalog
  message?: string
}

export interface UpdateInfo {
  current: string
  latest: string | null
  updateAvailable: boolean
  url: string
  name?: string
  notes?: string
  publishedAt?: string
  message?: string
}

export type AutoUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

/** State of the in-app update downloader (electron-updater). */
export interface AutoUpdateState {
  status: AutoUpdateStatus
  current: string
  version?: string
  percent?: number
  message?: string
}

export interface GuestInfo {
  hostname: string
  distro: string
  kernel: string
  user: string
  workspace: string
  memoryMB: number
  disk: string
}
