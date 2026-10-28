import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react'
import type {
  ApprovalRequest,
  Conversation,
  ConversationSummary,
  RuntimePhase,
  SettingsView,
  TaskState
} from '@shared/types'
import type { Translate } from '../i18n'
import logo from '../assets/logo.png'
import { Icon } from './Icon'
import { StatusPet, type PetState } from './StatusPet'
import { MarkdownText } from './MarkdownText'
import { ToolCallList } from './ToolCallList'

interface ChatPanelProps {
  t: Translate
  settings: SettingsView
  conversation: Conversation | null
  summaries: ConversationSummary[]
  task: TaskState
  runtimePhase: RuntimePhase
  approval: ApprovalRequest | null
  historyOpen: boolean
  onToggleHistory: () => void
  onNewTask: () => void
  onSelectConversation: (id: string) => void
  onDeleteConversation: (id: string) => void
  onOpenSettings: () => void
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
  onRetry: () => void
  onApprove: (approved: boolean) => void
}

const BUSY_STATES = new Set(['planning', 'running', 'waiting-approval', 'cancelling'])

export function ChatPanel(props: ChatPanelProps): JSX.Element {
  const { t, settings, conversation, summaries, task, runtimePhase, approval, historyOpen } = props
  const messages = conversation?.messages ?? []
  const busy = BUSY_STATES.has(task.status)
  const provider = settings.providers.find((entry) => entry.id === settings.provider)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [draftLength, setDraftLength] = useState(0)
  const petState: PetState = busy
    ? task.status === 'planning'
      ? 'thinking'
      : task.status === 'waiting-approval'
        ? 'waiting'
        : 'working'
    : runtimePhase !== 'running'
      ? 'offline'
      : task.status === 'error'
        ? 'sad'
        : draftLength > 0
          ? 'typing'
          : 'idle'

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 220
    if (nearBottom || busy) {
      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' })
    }
  }, [conversation?.updatedAt, busy, messages.length])

  const statusText = busy
    ? task.status === 'waiting-approval'
      ? t('waitingApproval')
      : task.activity ?? t('working')
    : runtimePhase === 'running'
      ? t('taskIdle')
      : runtimePhase === 'stopped' || runtimePhase === 'error'
        ? t('runtimeNotRunning')
        : t('linuxStarting')

  return (
    <aside className="chat-panel">
      <header className="chat-header">
        <div className="brand">
          <img className="brand-mark" src={logo} alt="" aria-hidden="true" />
          <span className="brand-text">
            <span className="brand-name">TagNest</span>
            <span className="brand-tagline">{t('brandTagline')}</span>
          </span>
        </div>
        <div className="header-actions">
          <button type="button" className="icon-button" title={t('history')} onClick={props.onToggleHistory}>
            <Icon name="clock" />
          </button>
          <button type="button" className="icon-button" title={t('newTask')} onClick={props.onNewTask}>
            <Icon name="plus" />
          </button>
          <button type="button" className="icon-button" title={t('settings')} onClick={props.onOpenSettings}>
            <Icon name="settings" />
          </button>
        </div>
      </header>

      <div className={`status-pill ${busy ? 'busy' : ''}`} aria-live="polite">
        <span className="status-text">{statusText}</span>
        <StatusPet state={petState} />
      </div>

      {historyOpen ? (
        <section className="history" aria-label={t('historyTitle')}>
          <div className="history-head">
            <span>{t('historyTitle')}</span>
            <button type="button" className="link-button" onClick={props.onNewTask}>
              <Icon name="plus" size={13} /> {t('newTask')}
            </button>
          </div>
          <div className="history-list">
            {summaries.length === 0 ? <p className="history-empty">{t('historyEmpty')}</p> : null}
            {summaries.map((item) => (
              <div
                key={item.id}
                className={`history-item ${item.id === conversation?.id ? 'active' : ''}`}
              >
                <button type="button" className="history-open" onClick={() => props.onSelectConversation(item.id)}>
                  <span className="history-title">{item.title}</span>
                  <span className="history-meta">{formatRelative(item.updatedAt)}</span>
                </button>
                <button
                  type="button"
                  className="history-delete"
                  title={t('delete')}
                  onClick={() => props.onDeleteConversation(item.id)}
                >
                  <Icon name="trash-small" size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="empty-state">
            <h1>{t('emptyTitle')}</h1>
            <p>{t('emptyText')}</p>
            <div className="suggestions">
              {[t('suggestion1'), t('suggestion2'), t('suggestion3'), t('suggestion4')].map((suggestion) => (
                <Suggestion key={suggestion} text={suggestion} onSend={props.onSend} />
              ))}
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message) => (
              <article key={message.id} className={`message message-${message.role}`}>
                <div className="message-label">
                  {message.role === 'user' ? t('you') : t('assistant')}
                  {message.role === 'assistant' && message.model ? <span>{message.model}</span> : null}
                </div>
                {message.content ? (
                  <div className="message-content">
                    {message.role === 'user' ? <p>{message.content}</p> : <MarkdownText text={message.content} />}
                  </div>
                ) : null}
                <ToolCallList calls={message.toolCalls} t={t} />
                {message.error ? (
                  <div className="message-error">
                    <Icon name="alert" size={14} />
                    <span>{message.error}</span>
                    {message.role === 'assistant' ? (
                      <button type="button" className="link-button" onClick={props.onRetry}>
                        {t('retry')}
                      </button>
                    ) : null}
                  </div>
                ) : null}
                {message.cancelled ? <div className="message-cancelled">{t('cancelledNote')}</div> : null}
                {message.role === 'assistant' && busy && task.conversationId === conversation?.id ? (
                  <div className="typing">
                    <span />
                    <span />
                    <span />
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </div>

      {approval ? <ApprovalCard request={approval} t={t} onDecide={props.onApprove} /> : null}

      <Composer
        t={t}
        busy={busy}
        disabled={runtimePhase !== 'running'}
        placeholder={
          runtimePhase === 'running'
            ? t('chatPlaceholder')
            : runtimePhase === 'stopped' || runtimePhase === 'error'
              ? t('runtimeNotRunningHint')
              : t('linuxStartingHint')
        }
        onSend={props.onSend}
        onStop={props.onStop}
        onDraftChange={setDraftLength}
      />

      <div className="composer-meta">
        <span className={`meta-dot ${runtimePhase === 'running' ? 'online' : ''}`} />
        <span>{provider?.label ?? settings.provider}</span>
        <span className="meta-sep">/</span>
        <span className="meta-model" title={settings.modelMode === 'free-auto' ? settings.model : undefined}>
          {settings.modelMode === 'free-auto'
            ? t('freeAutomatic')
            : settings.model || t('modelNotConfigured')}
        </span>
        <button type="button" className="meta-settings" onClick={props.onOpenSettings}>
          {t('settings')}
        </button>
      </div>
    </aside>
  )
}

function Composer({
  t,
  placeholder: placeholderText,
  busy,
  disabled,
  onSend,
  onStop,
  onDraftChange
}: {
  t: Translate
  busy: boolean
  disabled: boolean
  placeholder: string
  onSend: (text: string) => Promise<boolean>
  onStop: () => void
  onDraftChange?: (length: number) => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [sending, setSending] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const node = textareaRef.current
    if (!node) return
    node.style.height = 'auto'
    node.style.height = `${Math.min(150, node.scrollHeight)}px`
  }, [value])

  useEffect(() => {
    onDraftChange?.(value.length)
  }, [value, onDraftChange])

  const submit = async (): Promise<void> => {
    const text = value.trim()
    if (!text || busy || disabled || sending) return
    setSending(true)
    const ok = await onSend(text)
    setSending(false)
    if (ok) setValue('')
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void submit()
    }
  }

  return (
    <div className="composer">
      <textarea
        ref={textareaRef}
        value={value}
        rows={1}
        placeholder={placeholderText}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={busy}
        aria-label={t('chatPlaceholder')}
      />
      {busy ? (
        <button type="button" className="send-button stop" onClick={onStop} title={t('stop')} aria-label={t('stop')}>
          <Icon name="stop" size={14} />
        </button>
      ) : (
        <button
          type="button"
          className="send-button"
          onClick={() => void submit()}
          disabled={!value.trim() || disabled || sending}
          title={t('send')}
          aria-label={t('send')}
        >
          {sending ? <span className="mini-spin dark" /> : <Icon name="send" size={16} />}
        </button>
      )}
    </div>
  )
}

function Suggestion({ text, onSend }: { text: string; onSend: (text: string) => Promise<boolean> }): JSX.Element {
  return (
    <button type="button" className="suggestion" onClick={() => void onSend(text)}>
      <span>{text}</span>
      <Icon name="send" size={13} />
    </button>
  )
}

function ApprovalCard({
  request,
  t,
  onDecide
}: {
  request: ApprovalRequest
  t: Translate
  onDecide: (approved: boolean) => void
}): JSX.Element {
  return (
    <section className="approval-card" role="alertdialog" aria-label={t('approvalTitle')}>
      <div className="approval-head">
        <span className="approval-icon">
          <Icon name="alert" size={15} />
        </span>
        <div>
          <h2>{t('approvalTitle')}</h2>
          <p>{request.reason}</p>
        </div>
      </div>
      {request.command ? (
        <div className="approval-command">
          <span>{t('approvalCommand')}</span>
          <code>{request.command}</code>
        </div>
      ) : null}
      <p className="approval-note">{t('approvalNote')}</p>
      <div className="approval-actions">
        <button type="button" className="button ghost" onClick={() => onDecide(false)}>
          {t('deny')}
        </button>
        <button type="button" className="button solid" onClick={() => onDecide(true)}>
          {t('allowOnce')}
        </button>
      </div>
    </section>
  )
}

function formatRelative(timestamp: number): string {
  const delta = Date.now() - timestamp
  const minutes = Math.round(delta / 60000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
