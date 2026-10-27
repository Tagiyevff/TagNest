import { ipcMain, shell, type BrowserWindow } from 'electron'
import {
  activeConversationSchema,
  approvalResponseSchema,
  idSchema,
  IPC,
  providerOnlySchema,
  retrySchema,
  sendMessageSchema,
  setApiKeySchema,
  settingsPatchSchema
} from '../shared/ipc'
import type { AgentEvent, AppSnapshot } from '../shared/types'
import type { AgentRuntime } from './agent/agent'
import type { LinuxRuntime } from './linux/runtime'
import type { ConversationStore } from './storage/conversations'
import type { SecretsStore } from './storage/secrets'
import type { SettingsStore } from './storage/settings'
import { logger } from './logger'

export interface IpcDependencies {
  window: BrowserWindow
  settings: SettingsStore
  secrets: SecretsStore
  conversations: ConversationStore
  runtime: LinuxRuntime
  agent: AgentRuntime
}

export function registerIpc(deps: IpcDependencies): void {
  const { settings, secrets, conversations, runtime, agent, window } = deps

  const send = (channel: string, payload: unknown): void => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }

  const snapshot = (): AppSnapshot => ({
    settings: settings.getView(),
    runtime: runtime.getState(),
    conversations: conversations.list(),
    activeConversationId: conversations.getActiveId(),
    task: agent.getTask()
  })

  runtime.onState((state) => send(IPC.eventRuntime, state))
  const emitAgent = (event: AgentEvent): void => {
    send(IPC.eventAgent, event)
    if (event.type === 'conversation') {
      conversations.setActiveId(event.conversation.id)
    }
  }
  // The agent was constructed with an emit callback supplied by the app; it is
  // wired here through a setter to keep construction order simple.
  agent.setEmitter(emitAgent)

  ipcMain.handle(IPC.appGetState, () => snapshot())

  ipcMain.handle(IPC.appUpdateSettings, async (_event, raw: unknown) => {
    const patch = settingsPatchSchema.parse(raw)
    settings.update(patch)
    return snapshot()
  })

  ipcMain.handle(IPC.appSetApiKey, async (_event, raw: unknown) => {
    const { provider, apiKey } = setApiKeySchema.parse(raw)
    secrets.set(provider, apiKey.trim())
    return snapshot()
  })

  ipcMain.handle(IPC.appClearApiKey, async (_event, raw: unknown) => {
    const { provider } = providerOnlySchema.parse(raw)
    secrets.clear(provider)
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

  ipcMain.handle(IPC.appOpenLogs, async () => {
    const result = await shell.openPath(runtime.getLogsDirectory())
    return { ok: result === '' }
  })

  logger.info('ipc', 'handlers registered')
}
