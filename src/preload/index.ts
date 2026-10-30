import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/channels'
import type { TagNestApi } from '../shared/api'

const subscribe = <T>(channel: string, listener: (payload: T) => void): (() => void) => {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: TagNestApi = {
  getState: () => ipcRenderer.invoke(IPC.appGetState),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.appUpdateSettings, patch),
  setApiKey: (provider, apiKey) => ipcRenderer.invoke(IPC.appSetApiKey, { provider, apiKey }),
  clearApiKey: (provider) => ipcRenderer.invoke(IPC.appClearApiKey, { provider }),
  conversations: {
    list: () => ipcRenderer.invoke(IPC.conversationsList),
    get: (id) => ipcRenderer.invoke(IPC.conversationsGet, { id }),
    create: () => ipcRenderer.invoke(IPC.conversationsCreate),
    delete: (id) => ipcRenderer.invoke(IPC.conversationsDelete, { id }),
    setActive: (id) => ipcRenderer.invoke(IPC.conversationsSetActive, { id })
  },
  agent: {
    send: (input) => ipcRenderer.invoke(IPC.agentSend, input),
    cancel: () => ipcRenderer.invoke(IPC.agentCancel),
    approve: (requestId, approved) => ipcRenderer.invoke(IPC.agentApproval, { requestId, approved }),
    retry: (conversationId) => ipcRenderer.invoke(IPC.agentRetry, { conversationId })
  },
  runtime: {
    getState: () => ipcRenderer.invoke(IPC.runtimeGet),
    start: () => ipcRenderer.invoke(IPC.runtimeStart),
    stop: () => ipcRenderer.invoke(IPC.runtimeStop),
    restart: () => ipcRenderer.invoke(IPC.runtimeRestart),
    logs: () => ipcRenderer.invoke(IPC.runtimeLogs),
    openLogFolder: () => ipcRenderer.invoke(IPC.appOpenLogs),
    stats: () => ipcRenderer.invoke(IPC.runtimeStats),
    installQemu: () => ipcRenderer.invoke(IPC.runtimeInstallQemu),
    checkpoint: () => ipcRenderer.invoke(IPC.runtimeCheckpoint),
    rollbackCheckpoint: () => ipcRenderer.invoke(IPC.runtimeRollbackCheckpoint),
    keepCheckpoint: () => ipcRenderer.invoke(IPC.runtimeKeepCheckpoint)
  },
  files: {
    list: (path) => ipcRenderer.invoke(IPC.workspaceList, { path }),
    upload: (input) => ipcRenderer.invoke(IPC.workspaceUpload, input),
    download: (path) => ipcRenderer.invoke(IPC.workspaceDownload, { path })
  },
  setup: {
    status: () => ipcRenderer.invoke(IPC.setupStatus)
  },
  provider: {
    test: () => ipcRenderer.invoke(IPC.providerTest),
    models: () => ipcRenderer.invoke(IPC.providerModels)
  },
  remote: {
    getState: () => ipcRenderer.invoke(IPC.remoteGetState),
    enable: (input) => ipcRenderer.invoke(IPC.remoteEnable, input),
    disable: () => ipcRenderer.invoke(IPC.remoteDisable),
    regenerateCode: () => ipcRenderer.invoke(IPC.remoteRegenerateCode),
    revokeDevice: (id) => ipcRenderer.invoke(IPC.remoteRevokeDevice, { id })
  },
  app: {
    checkUpdates: () => ipcRenderer.invoke(IPC.appCheckUpdates),
    diagnostics: () => ipcRenderer.invoke(IPC.appDiagnostics)
  },
  updates: {
    state: () => ipcRenderer.invoke(IPC.appUpdateState),
    check: () => ipcRenderer.invoke(IPC.appUpdateCheck),
    install: () => ipcRenderer.invoke(IPC.appUpdateInstall)
  },
  onRuntimeState: (listener) => subscribe(IPC.eventRuntime, listener),
  onAgentEvent: (listener) => subscribe(IPC.eventAgent, listener),
  onSettings: (listener) => subscribe(IPC.eventSettings, listener),
  onUpdateState: (listener) => subscribe(IPC.eventUpdate, listener),
  onRemoteState: (listener) => subscribe(IPC.eventRemote, listener)
}

contextBridge.exposeInMainWorld('tagnest', api)
