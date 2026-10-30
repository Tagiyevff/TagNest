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
  runtimeInstallQemu: 'runtime:install-qemu',
  runtimeCheckpoint: 'runtime:checkpoint',
  runtimeRollbackCheckpoint: 'runtime:rollback-checkpoint',
  runtimeKeepCheckpoint: 'runtime:keep-checkpoint',
  workspaceList: 'workspace:list',
  workspaceUpload: 'workspace:upload',
  workspaceDownload: 'workspace:download',
  providerTest: 'provider:test',
  providerModels: 'provider:models',
  remoteGetState: 'remote:get-state',
  remoteEnable: 'remote:enable',
  remoteDisable: 'remote:disable',
  remoteRegenerateCode: 'remote:regenerate-code',
  remoteRevokeDevice: 'remote:revoke-device',
  appCheckUpdates: 'app:check-updates',
  appDiagnostics: 'app:diagnostics',
  setupStatus: 'setup:status',
  appOpenLogs: 'app:open-logs',
  appUpdateState: 'app:update-state',
  appUpdateCheck: 'app:update-check',
  appUpdateInstall: 'app:update-install',
  eventRuntime: 'event:runtime',
  eventAgent: 'event:agent',
  eventSettings: 'event:settings',
  eventUpdate: 'event:update',
  eventRemote: 'event:remote'
} as const
