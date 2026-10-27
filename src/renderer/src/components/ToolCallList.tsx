import { useState, type JSX } from 'react'
import type { ToolCallView } from '@shared/types'
import type { Translate } from '../i18n'
import { Icon } from './Icon'

const STATE_LABEL = {
  running: 'toolRunning',
  'awaiting-approval': 'toolAwaiting',
  ok: 'toolOk',
  error: 'toolError',
  denied: 'toolDenied',
  cancelled: 'toolCancelled'
} as const

export function ToolCallList({ calls, t }: { calls: ToolCallView[]; t: Translate }): JSX.Element | null {
  if (calls.length === 0) return null
  return (
    <div className="tool-list">
      {calls.map((call) => (
        <ToolCallItem key={call.id} call={call} t={t} />
      ))}
    </div>
  )
}

function ToolCallItem({ call, t }: { call: ToolCallView; t: Translate }): JSX.Element {
  const [open, setOpen] = useState(call.state === 'error' || call.state === 'denied')
  const pending = call.state === 'running' || call.state === 'awaiting-approval'
  return (
    <div className={`tool tool-${call.state}`}>
      <button className="tool-header" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className={`tool-indicator ${call.state}`}>
          {pending ? (
            <span className="mini-spin" />
          ) : call.state === 'ok' ? (
            <Icon name="check" size={12} />
          ) : (
            <Icon name="x" size={12} />
          )}
        </span>
        <span className="tool-title">{call.title}</span>
        {call.summary ? <span className="tool-summary">{call.summary}</span> : null}
        <span className="tool-label">{t(STATE_LABEL[call.state])}</span>
        <span className={`tool-chevron ${open ? 'open' : ''}`}>
          <Icon name="chevron" size={14} />
        </span>
      </button>
      {open && call.output ? (
        <div className="tool-body">
          <pre className="tool-output">{call.output}</pre>
        </div>
      ) : null}
    </div>
  )
}
