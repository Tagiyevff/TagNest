import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AgentEvent,
  ApprovalRequest,
  Conversation,
  ConversationSummary,
  RuntimeState,
  SettingsView,
  TaskState
} from '@shared/types'
import type { SettingsPatch } from '@shared/ipc'
import { ChatPanel } from './components/ChatPanel'
import { LinuxPanel } from './components/LinuxPanel'
import { SettingsDialog } from './components/SettingsDialog'
import { createTranslator } from './i18n'

interface Toast {
  id: number
  level: 'info' | 'error'
  message: string
}

export default function App(): JSX.Element {
  const [ready, setReady] = useState(false)
  const [fatal, setFatal] = useState('')
  const [version, setVersion] = useState('')
  const [settings, setSettings] = useState<SettingsView | null>(null)
  const [runtime, setRuntime] = useState<RuntimeState | null>(null)
  const [conversation, setConversation] = useState<Conversation | null>(null)
  const [summaries, setSummaries] = useState<ConversationSummary[]>([])
  const [task, setTask] = useState<TaskState>({ conversationId: null, status: 'idle' })
  const [approval, setApproval] = useState<ApprovalRequest | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [pointer, setPointer] = useState<{ x: number; y: number; at: number } | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const activeIdRef = useRef<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const language = settings?.language ?? 'en'
  const t = useMemo(() => createTranslator(language), [language])
  const busy = ['planning', 'running', 'waiting-approval', 'cancelling'].includes(task.status)

  const showToast = useCallback((level: 'info' | 'error', message: string): void => {
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    const item = { id: Date.now(), level, message }
    setToast(item)
    toastTimer.current = window.setTimeout(() => {
      setToast((current) => (current?.id === item.id ? null : current))
    }, 5000)
  }, [])

  const handleAgentEvent = useCallback(
    (event: AgentEvent): void => {
      if (event.type === 'conversation') {
        const incoming = event.conversation
        setSummaries((current) => {
          const summary: ConversationSummary = {
            id: incoming.id,
            title: incoming.title,
            createdAt: incoming.createdAt,
            updatedAt: incoming.updatedAt,
            messageCount: incoming.messages.length
          }
          return [summary, ...current.filter((entry) => entry.id !== summary.id)].sort(
            (a, b) => b.updatedAt - a.updatedAt
          )
        })
        if (!activeIdRef.current || activeIdRef.current === incoming.id) {
          activeIdRef.current = incoming.id
          setConversation(incoming)
          const pointers = incoming.messages
            .flatMap((message) => message.toolCalls)
            .filter((call) => Boolean(call.pointer))
          const lastPointer = pointers[pointers.length - 1]?.pointer
          if (lastPointer) setPointer({ x: lastPointer.x, y: lastPointer.y, at: Date.now() })
        }
        return
      }
      if (event.type === 'message-updated') {
        setConversation((current) => {
          if (!current || current.id !== event.conversationId) return current
          return {
            ...current,
            messages: current.messages.map((message) =>
              message.id === event.message.id ? event.message : message
            ),
            updatedAt: Date.now()
          }
        })
        return
      }
      if (event.type === 'task-state') {
        setTask(event.task)
        return
      }
      if (event.type === 'approval-request') {
        setApproval(event.request)
        return
      }
      if (event.type === 'approval-resolved') {
        setApproval((current) => (current?.id === event.requestId ? null : current))
        return
      }
      if (event.type === 'notice') {
        showToast(event.level, event.message)
      }
    },
    [showToast]
  )

  useEffect(() => {
    const api = window.tagnest
    if (!api) return
    let disposed = false
    api
      .getState()
      .then(async (state) => {
        if (disposed) return
        setVersion(state.version)
        setSettings(state.settings)
        setRuntime(state.runtime)
        setTask(state.task)
        setSummaries(state.conversations)
        const activeId = state.activeConversationId ?? state.conversations[0]?.id ?? null
        if (activeId) {
          const loaded = await api.conversations.get(activeId)
          if (!disposed && loaded) {
            activeIdRef.current = loaded.id
            setConversation(loaded)
          }
        }
        if (!disposed) setReady(true)
      })
      .catch((error: unknown) => {
        if (!disposed) setFatal(error instanceof Error ? error.message : String(error))
      })

    const offRuntime = api.onRuntimeState(setRuntime)
    const offAgent = api.onAgentEvent(handleAgentEvent)
    const offSettings = api.onSettings(setSettings)
    return () => {
      disposed = true
      offRuntime()
      offAgent()
      offSettings()
    }
  }, [handleAgentEvent])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey)) return
      if (event.key === ',') {
        event.preventDefault()
        setSettingsOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const updateSettings = useCallback(
    async (patch: SettingsPatch): Promise<void> => {
      const state = await window.tagnest.updateSettings(patch)
      setSettings(state.settings)
      setRuntime(state.runtime)
    },
    []
  )

  const setApiKey = useCallback(async (provider: SettingsView['provider'], key: string): Promise<void> => {
    const state = await window.tagnest.setApiKey(provider, key)
    setSettings(state.settings)
  }, [])

  const clearApiKey = useCallback(async (provider: SettingsView['provider']): Promise<void> => {
    const state = await window.tagnest.clearApiKey(provider)
    setSettings(state.settings)
  }, [])

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      if (busy) return false
      if (!runtime || runtime.phase !== 'running') {
        showToast('error', t('runtimeNotRunningHint'))
        return false
      }
      try {
        const result = await window.tagnest.agent.send({
          conversationId: activeIdRef.current ?? undefined,
          text
        })
        if (activeIdRef.current !== result.conversationId) {
          activeIdRef.current = result.conversationId
          const loaded = await window.tagnest.conversations.get(result.conversationId)
          if (loaded) setConversation(loaded)
        }
        setApproval(null)
        return true
      } catch (error) {
        showToast('error', error instanceof Error ? cleanIpcError(error.message) : String(error))
        return false
      }
    },
    [busy, runtime, showToast, t]
  )

  const newTask = useCallback(async (): Promise<void> => {
    if (busy) {
      showToast('info', t('stopFirst'))
      return
    }
    const created = await window.tagnest.conversations.create()
    activeIdRef.current = created.id
    setConversation(created)
    setSummaries((current) => [
      {
        id: created.id,
        title: created.title,
        createdAt: created.createdAt,
        updatedAt: created.updatedAt,
        messageCount: 0
      },
      ...current
    ])
    setApproval(null)
    setHistoryOpen(false)
  }, [busy, showToast, t])

  const selectConversation = useCallback(async (id: string): Promise<void> => {
    const loaded = await window.tagnest.conversations.get(id)
    if (!loaded) return
    activeIdRef.current = id
    setConversation(loaded)
    setApproval(null)
    setHistoryOpen(false)
    void window.tagnest.conversations.setActive(id)
  }, [])

  const deleteConversation = useCallback(
    async (id: string): Promise<void> => {
      if (busy && task.conversationId === id) {
        showToast('error', t('stopFirst'))
        return
      }
      const result = await window.tagnest.conversations.delete(id)
      if (!result.deleted) return
      setSummaries((current) => current.filter((entry) => entry.id !== id))
      if (activeIdRef.current === id) {
        activeIdRef.current = null
        setConversation(null)
      }
    },
    [busy, showToast, t, task.conversationId]
  )

  const approve = useCallback(
    async (approved: boolean): Promise<void> => {
      if (!approval) return
      const id = approval.id
      setApproval(null)
      try {
        await window.tagnest.agent.approve(id, approved)
      } catch (error) {
        showToast('error', error instanceof Error ? error.message : String(error))
      }
    },
    [approval, showToast]
  )

  const startRuntime = useCallback((): void => {
    void window.tagnest.runtime.start().catch((error: unknown) => {
      showToast('error', error instanceof Error ? cleanIpcError(error.message) : String(error))
    })
  }, [showToast])

  const stopRuntime = useCallback((): void => {
    void window.tagnest.runtime.stop().catch((error: unknown) => {
      showToast('error', error instanceof Error ? cleanIpcError(error.message) : String(error))
    })
  }, [showToast])

  const restartRuntime = useCallback((): void => {
    void window.tagnest.runtime.restart().catch((error: unknown) => {
      showToast('error', error instanceof Error ? cleanIpcError(error.message) : String(error))
    })
  }, [showToast])

  if (!window.tagnest) {
    return (
      <div className="app-fatal">
        <h1>TagNest</h1>
        <p>The TagNest preload bridge is unavailable. Start the app through Electron, not a browser tab.</p>
      </div>
    )
  }

  if (fatal) {
    return (
      <div className="app-fatal">
        <h1>TagNest</h1>
        <p>{fatal}</p>
      </div>
    )
  }

  if (!ready || !settings || !runtime) {
    return (
      <div className="app-loading">
        <span className="loading-mark" />
        <span>TagNest</span>
      </div>
    )
  }

  return (
    <div className="app">
      <ChatPanel
        t={t}
        settings={settings}
        conversation={conversation}
        summaries={summaries}
        task={task}
        runtimePhase={runtime.phase}
        approval={approval}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen((value) => !value)}
        onNewTask={() => void newTask()}
        onSelectConversation={(id) => void selectConversation(id)}
        onDeleteConversation={(id) => void deleteConversation(id)}
        onOpenSettings={() => setSettingsOpen(true)}
        onSend={send}
        onStop={() => void window.tagnest.agent.cancel()}
        onRetry={() => {
          if (conversation) void window.tagnest.agent.retry(conversation.id)
        }}
        onApprove={(approved) => void approve(approved)}
      />
      <LinuxPanel
        t={t}
        runtime={runtime}
        task={task}
        pointer={pointer}
        onStart={startRuntime}
        onStop={stopRuntime}
        onRestart={restartRuntime}
        onOpenLogs={() => void window.tagnest.runtime.openLogFolder()}
      />
      {settingsOpen ? (
        <SettingsDialog
          key={settings.provider}
          t={t}
          version={version}
          settings={settings}
          runtime={runtime}
          onClose={() => setSettingsOpen(false)}
          onUpdate={updateSettings}
          onSetKey={setApiKey}
          onClearKey={clearApiKey}
          onOpenLogs={() => void window.tagnest.runtime.openLogFolder()}
        />
      ) : null}
      {toast ? <div className={`toast toast-${toast.level}`}>{toast.message}</div> : null}
    </div>
  )
}

function cleanIpcError(message: string): string {
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^Error:\s*/, '')
}
