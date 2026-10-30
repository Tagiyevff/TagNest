import { app, dialog, ipcMain, shell, type BrowserWindow } from 'electron'
import { existsSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  activeConversationSchema,
  approvalResponseSchema,
  idSchema,
  IPC,
  PROVIDER_IDS,
  providerOnlySchema,
  remoteEnableSchema,
  retrySchema,
  sendMessageSchema,
  setApiKeySchema,
  settingsPatchSchema,
  workspaceDownloadSchema,
  workspaceListSchema,
  workspaceUploadSchema
} from '../shared/ipc'
import type { AgentEvent, AppSnapshot } from '../shared/types'
import { PROVIDERS, type DiagnosticsResult, type SetupStatus } from '../shared/types'
import type { AgentRuntime } from './agent/agent'
import { buildDiagnostics } from './diagnostics'
import type { AutoUpdateController } from './auto-update'
import type { LinuxRuntime } from './linux/runtime'
import type { RemoteAccess } from './remote/remote'
import { applyLaunchAtLogin } from './login-item'
import type { ConversationStore } from './storage/conversations'
import type { SecretsStore } from './storage/secrets'
import type { SettingsStore } from './storage/settings'
import { logger } from './logger'
import { listConfiguredProviderModels } from './agent/provider-models'
import { testProviderConnection } from './agent/provider-test'
import { checkForUpdates } from './updates'
import {
  downloadWorkspaceFile,
  listWorkspace,
  pickAndUploadFiles,
  uploadBuffers,
  uploadHostPaths
} from './workspace/files'

export interface IpcDependencies {
  window: BrowserWindow
  settings: SettingsStore
  secrets: SecretsStore
  conversations: ConversationStore
  runtime: LinuxRuntime
  agent: AgentRuntime
  updates: AutoUpdateController
  remote: RemoteAccess
}

export function registerIpc(deps: IpcDependencies): void {
  const { settings, secrets, conversations, runtime, agent, updates, remote, window } = deps

  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const snapshot = (): AppSnapshot => ({
    version: app.getVersion(),
    settings: settings.getView(),
    runtime: runtime.getState(),
    conversations: conversations.list(),
    activeConversationId: conversations.getActiveId(),
    task: agent.getTask(),
    remote: remote.getState()
  })

  runtime.onState((state) => send(IPC.eventRuntime, state))
  updates.onState((state) => send(IPC.eventUpdate, state))
  remote.onState((state) => send(IPC.eventRemote, state))
  const emitAgent = (event: AgentEvent): void => {
    send(IPC.eventAgent, event)
    if (event.type === 'conversation') {
      conversations.setActiveId(event.conversation.id)
    }
  }
  // The agent was constructed with an emit callback supplied by the app; it is
  // wired here through a setter to keep construction order simple.
  agent.setEmitter(emitAgent)
  agent.setSettingsEmitter((view) => send(IPC.eventSettings, view))

  ipcMain.handle(IPC.appGetState, () => snapshot())

  ipcMain.handle(IPC.appUpdateSettings, async (_event, raw: unknown) => {
    const patch = settingsPatchSchema.parse(raw)
    settings.update(patch)
    if (typeof patch.launchAtLogin === 'boolean') applyLaunchAtLogin(patch.launchAtLogin)
    send(IPC.eventSettings, settings.getView())
    return snapshot()
  })

  ipcMain.handle(IPC.appSetApiKey, async (_event, raw: unknown) => {
    const { provider, apiKey } = setApiKeySchema.parse(raw)
    secrets.set(provider, apiKey.trim())
    send(IPC.eventSettings, settings.getView())
    return snapshot()
  })

  ipcMain.handle(IPC.appClearApiKey, async (_event, raw: unknown) => {
    const { provider } = providerOnlySchema.parse(raw)
    secrets.clear(provider)
    send(IPC.eventSettings, settings.getView())
    return snapshot()
  })

  ipcMain.handle(IPC.conversationsList, () => conversations.list())

  ipcMain.handle(IPC.conversationsGet, async (_event, raw: unknown) => {
    const { id } = idSchema.parse(raw)
    return conversations.get(id) ?? null
  })

  ipcMain.handle(IPC.conversationsCreate, () => {
    const conversation = conversations.create()
    conversations.setActiveId(conversation.id)
    return conversation
  })

  ipcMain.handle(IPC.conversationsDelete, async (_event, raw: unknown) => {
    const { id } = idSchema.parse(raw)
    const deleted = conversations.delete(id)
    if (conversations.getActiveId() === id) conversations.setActiveId(null)
    return { deleted }
  })

  ipcMain.handle(IPC.conversationsSetActive, async (_event, raw: unknown) => {
    const { id } = activeConversationSchema.parse(raw)
    conversations.setActiveId(id)
    return { ok: true } as const
  })

  ipcMain.handle(IPC.agentSend, async (_event, raw: unknown) => {
    const input = sendMessageSchema.parse(raw)
    return agent.send(input)
  })

  ipcMain.handle(IPC.agentCancel, () => {
    agent.cancel()
    return { ok: true }
  })

  ipcMain.handle(IPC.agentApproval, async (_event, raw: unknown) => {
    const { requestId, approved } = approvalResponseSchema.parse(raw)
    agent.respondApproval(requestId, approved)
    return { ok: true }
  })

  ipcMain.handle(IPC.agentRetry, async (_event, raw: unknown) => {
    const { conversationId } = retrySchema.parse(raw)
    await agent.retry(conversationId)
    return { ok: true }
  })

  ipcMain.handle(IPC.runtimeGet, () => runtime.getState())

  ipcMain.handle(IPC.runtimeStart, async () => {
    await runtime.start()
    return runtime.getState()
  })

  ipcMain.handle(IPC.runtimeStop, async () => {
    await runtime.stop()
    return runtime.getState()
  })

  ipcMain.handle(IPC.runtimeRestart, async () => {
    await runtime.restart()
    return runtime.getState()
  })

  ipcMain.handle(IPC.runtimeLogs, async () => runtime.getLogs())

  ipcMain.handle(IPC.runtimeStats, async () => runtime.getStats())

  ipcMain.handle(IPC.runtimeInstallQemu, async () => runtime.installQemu())

  ipcMain.handle(IPC.runtimeCheckpoint, async () => runtime.createCheckpoint('manual'))

  ipcMain.handle(IPC.runtimeRollbackCheckpoint, async () => runtime.rollbackCheckpoint())

  ipcMain.handle(IPC.runtimeKeepCheckpoint, async () => runtime.keepCheckpoint())

  ipcMain.handle(IPC.workspaceList, async (_event, raw: unknown) => {
    const { path } = workspaceListSchema.parse(raw ?? {})
    return listWorkspace(runtime.getGuest(), path)
  })

  ipcMain.handle(IPC.workspaceUpload, async (_event, raw: unknown) => {
    const input = workspaceUploadSchema.parse(raw)
    const guest = runtime.getGuest()
    if (input.pick) return pickAndUploadFiles(guest, window)
    if (input.hostPaths?.length) return uploadHostPaths(guest, input.hostPaths)
    if (input.files?.length) return uploadBuffers(guest, input.files)
    throw new Error('No files were provided to copy into Linux.')
  })

  ipcMain.handle(IPC.workspaceDownload, async (_event, raw: unknown) => {
    const { path } = workspaceDownloadSchema.parse(raw)
    return downloadWorkspaceFile(runtime.getGuest(), path, window)
  })

  ipcMain.handle(IPC.providerTest, async () => testProviderConnection(settings, secrets))

  ipcMain.handle(IPC.providerModels, async () => listConfiguredProviderModels(settings, secrets))

  ipcMain.handle(IPC.remoteGetState, () => remote.getState())

  ipcMain.handle(IPC.remoteEnable, async (_event, raw: unknown) => {
    const input = remoteEnableSchema.parse(raw)
    return remote.enable(input.mode, input.customUrl ?? '')
  })

  ipcMain.handle(IPC.remoteDisable, async () => remote.disable())

  ipcMain.handle(IPC.remoteRegenerateCode, () => remote.regenerateCode())

  ipcMain.handle(IPC.remoteRevokeDevice, async (_event, raw: unknown) => {
    const { id } = idSchema.parse(raw)
    return remote.revokeDevice(id)
  })

  ipcMain.handle(IPC.appCheckUpdates, async () => checkForUpdates(app.getVersion()))

  ipcMain.handle(IPC.setupStatus, async (): Promise<SetupStatus> => {
    const current = settings.get()
    const provider = PROVIDERS.find((entry) => entry.id === current.provider)
    const hasKey = secrets.has(current.provider)
    const modelReady =
      Boolean(current.model || current.modelMode === 'free-auto') &&
      (!provider?.requiresApiKey || hasKey)
    const acceleration = await runtime.getAccelerationStatus()
    const paths = runtime.getLinuxPaths()
    const state = runtime.getState()
    return {
      qemuFound: state.qemuFound,
      qemuCanInstall: state.qemuCanInstall,
      acceleration: acceleration.acceleration,
      accelerationWarning: acceleration.warning,
      firstRun: !existsSync(paths.disk),
      imageReady: existsSync(paths.baseImage),
      modelReady,
      provider: current.provider,
      model: current.model || undefined,
      // TAGNEST_FORCE_SETUP is a UI test hook; it only opens the checklist.
      needsSetup:
        process.env.TAGNEST_FORCE_SETUP === '1' ||
        !state.qemuFound ||
        !modelReady ||
        acceleration.acceleration === 'tcg'
    }
  })

  ipcMain.handle(IPC.appDiagnostics, async (): Promise<DiagnosticsResult> => {
    const state = runtime.getState()
    const paths = runtime.getLinuxPaths()
    const rawLogs = await runtime.getLogs()
    const [serialSection, qemuSection = ''] = rawLogs.tail.split('=== QEMU stderr ===')
    const secretPresence: Record<string, boolean> = {}
    for (const provider of PROVIDER_IDS) secretPresence[provider] = secrets.has(provider)
    const sizeOf = (path: string): number | undefined => {
      try {
        return statSync(path).size
      } catch {
        return undefined
      }
    }
    const report = buildDiagnostics({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      node: process.versions.node,
      settings: settings.getView(),
      runtime: state,
      secrets: secretPresence,
      disk: {
        baseImageBytes: sizeOf(paths.baseImage),
        workspaceBytes: sizeOf(paths.disk)
      },
      logs: {
        app: logger.tail(300),
        serial: serialSection.replace('=== Linux serial console ===', '').trim(),
        qemu: qemuSection.trim()
      },
      redactions: [homedir(), app.getPath('userData'), paths.root, process.cwd()]
    })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const documents = (() => {
      try {
        return app.getPath('documents')
      } catch {
        return app.getPath('userData')
      }
    })()
    const result = await dialog.showSaveDialog(window, {
      title: 'Save TagNest diagnostics',
      defaultPath: join(documents, `tagnest-diagnostics-${stamp}.txt`),
      filters: [{ name: 'Text report', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return { saved: false }
    writeFileSync(result.filePath, report, 'utf8')
    logger.info('diagnostics', 'diagnostics report saved')
    return { saved: true, path: result.filePath }
  })

  ipcMain.handle(IPC.appUpdateState, () => updates.getState())

  ipcMain.handle(IPC.appUpdateCheck, async () => updates.check())

  ipcMain.handle(IPC.appUpdateInstall, async () => {
    updates.install()
    return { ok: true } as const
  })

  ipcMain.handle(IPC.appOpenLogs, async () => {
    const result = await shell.openPath(runtime.getLogsDirectory())
    return { ok: result === '' }
  })

  logger.info('ipc', 'handlers registered')
}
