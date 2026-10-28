/**
 * IPC channel names, kept in a dependency-free module.
 *
 * The preload runs with `sandbox: true`, where only `electron` and a small set
 * of Node built-ins may be required. Importing these names from `ipc.ts` would
 * pull Zod into the preload bundle, which the sandbox refuses to load.
 */
export const IPC = {
  appGetState: 'app:get-state',
  appUpdateSettings: 'app:update-settings',
  appSetApiKey: 'app:set-api-key',
  appClearApiKey: 'app:clear-api-key',
  conversationsList: 'conversations:list',
  conversationsGet: 'conversations:get',
  conversationsCreate: 'conversations:create',
  conversationsDelete: 'conversations:delete',
  conversationsSetActive: 'conversations:set-active',
  agentSend: 'agent:send',
  agentCancel: 'agent:cancel',
  agentApproval: 'agent:approval',
  agentRetry: 'agent:retry',
  runtimeGet: 'runtime:get',
  runtimeStart: 'runtime:start',
  runtimeStop: 'runtime:stop',
  runtimeRestart: 'runtime:restart',
  runtimeLogs: 'runtime:logs',
  runtimeStats: 'runtime:stats',
  workspaceList: 'workspace:list',
  workspaceUpload: 'workspace:upload',
  workspaceDownload: 'workspace:download',
  providerTest: 'provider:test',
  appCheckUpdates: 'app:check-updates',
  appOpenLogs: 'app:open-logs',
  eventRuntime: 'event:runtime',
  eventAgent: 'event:agent'
} as const
