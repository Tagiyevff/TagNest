import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type RFBType from '@novnc/novnc'
import type { RFBClipboardEvent } from '@novnc/novnc'
import type { RuntimePhase, RuntimeState, TaskState } from '@shared/types'
import { DESKTOP_HEIGHT, DESKTOP_WIDTH } from '@shared/constants'
import type { Translate } from '../i18n'
import { Icon } from './Icon'

interface LinuxPanelProps {
  t: Translate
  runtime: RuntimeState
  task: TaskState
  pointer: { x: number; y: number; at: number } | null
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onOpenLogs: () => void
}

const PHASE_KEYS: Record<RuntimePhase, Parameters<Translate>[0]> = {
  stopped: 'phaseStopped',
  preparing: 'phasePreparing',
  'downloading-image': 'phaseDownloading',
  'creating-disk': 'phaseCreating',
  starting: 'phaseStarting',
  provisioning: 'phaseProvisioning',
  connecting: 'phaseConnecting',
  running: 'phaseRunning',
  stopping: 'phaseStopping',
  error: 'phaseError'
}

const BUSY_TASK_STATES = new Set(['planning', 'running', 'waiting-approval', 'cancelling'])

export function LinuxPanel(props: LinuxPanelProps): JSX.Element {
  const { t, runtime, task } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const rfbRef = useRef<RFBType | null>(null)
  const stageRef = useRef<HTMLElement>(null)
  const [screen, setScreen] = useState<'idle' | 'connecting' | 'connected' | 'lost'>('idle')
  const [screenError, setScreenError] = useState<string | null>(null)
  const [guestClipboard, setGuestClipboard] = useState('')
  const [clipboardOpen, setClipboardOpen] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const [hintVisible, setHintVisible] = useState(true)
  const [logsOpen, setLogsOpen] = useState(false)
  const [logs, setLogs] = useState('')
  const [logsLoading, setLogsLoading] = useState(false)
  const [clipboardError, setClipboardError] = useState('')
  const [screenRect, setScreenRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const aiWorking = BUSY_TASK_STATES.has(task.status)
  const phase = runtime.phase

  useEffect(() => {
    const url = runtime.vncUrl
    if (!url) return
    let cancelled = false
    const host = hostRef.current
    queueMicrotask(() => {
      if (cancelled) return
      setScreen('connecting')
      setScreenError(null)
      setHintVisible(true)
    })
    let rfb: RFBType | null = null

    void import('@novnc/novnc')
      .then(({ default: RFB }) => {
        if (cancelled || !host) return
        rfb = new RFB(host, url, { shared: true, wsProtocols: ['binary'] })
        rfb.background = '#151b20'
        rfb.scaleViewport = true
        rfb.resizeSession = false
        rfb.clipViewport = false
        rfb.focusOnClick = true
        rfb.addEventListener('connect', () => {
          if (!cancelled) setScreen('connected')
        })
        rfb.addEventListener('disconnect', () => {
          if (!cancelled) setScreen('lost')
        })
        rfb.addEventListener('clipboard', (event) => {
          const clipboardEvent = event as RFBClipboardEvent
          if (typeof clipboardEvent.detail?.text === 'string') setGuestClipboard(clipboardEvent.detail.text)
        })
        rfbRef.current = rfb
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setScreenError(error instanceof Error ? error.message : String(error))
        setScreen('lost')
      })

    return () => {
      cancelled = true
      rfbRef.current = null
      try {
        rfb?.disconnect()
      } catch {
        /* already closed */
      }
      if (host) host.innerHTML = ''
    }
  }, [runtime.vncUrl])

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 2000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    if (!runtime.startedAt) return
    const timer = setTimeout(() => setHintVisible(false), 8000)
    return () => clearTimeout(timer)
  }, [runtime.startedAt])

  useEffect(() => {
    if (!props.pointer) return
    const timer = setTimeout(() => setNow(Date.now()), 7200)
    return () => clearTimeout(timer)
  }, [props.pointer])

  // Map guest pixels onto the exact letterboxed canvas area of the VNC view.
  useEffect(() => {
    const update = (): void => {
      const host = hostRef.current
      const shell = host?.parentElement
      const canvas = host?.querySelector('canvas')
      if (!host || !shell || !canvas) return
      const canvasRect = canvas.getBoundingClientRect()
      const shellRect = shell.getBoundingClientRect()
      if (canvasRect.width < 1 || canvasRect.height < 1) return
      setScreenRect({
        left: canvasRect.left - shellRect.left,
        top: canvasRect.top - shellRect.top,
        width: canvasRect.width,
        height: canvasRect.height
      })
    }
    update()
    const observer = new ResizeObserver(update)
    if (hostRef.current) observer.observe(hostRef.current)
    const canvas = hostRef.current?.querySelector('canvas')
    if (canvas) observer.observe(canvas)
    window.addEventListener('resize', update)
    const settle = setTimeout(update, 1200)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', update)
      clearTimeout(settle)
    }
  }, [screen, runtime.vncUrl])

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen()
    } else {
      void stageRef.current?.requestFullscreen?.()
    }
  }, [])

  const pasteClipboard = async (): Promise<void> => {
    try {
      const text = await navigator.clipboard.readText()
      rfbRef.current?.clipboardPasteFrom(text)
      setClipboardOpen(false)
      setClipboardError('')
    } catch {
      setClipboardError(t('clipboardUnavailable'))
    }
  }

  const copyGuestClipboard = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(guestClipboard)
      setClipboardOpen(false)
      setClipboardError('')
    } catch {
      setClipboardError(t('clipboardUnavailable'))
    }
  }

  const openLogs = async (): Promise<void> => {
    setLogsOpen(true)
    setLogsLoading(true)
    try {
      const result = await window.tagnest.runtime.logs()
      setLogs(result.tail || 'Log is empty.')
    } catch (error) {
      setLogs(error instanceof Error ? error.message : String(error))
    } finally {
      setLogsLoading(false)
    }
  }

  const pointer = props.pointer
  const pointerFresh = pointer && now - pointer.at < 7000
  const pointerStyle = pointer
    ? screenRect
      ? {
          left: `${screenRect.left + (pointer.x / DESKTOP_WIDTH) * screenRect.width}px`,
          top: `${screenRect.top + (pointer.y / DESKTOP_HEIGHT) * screenRect.height}px`
        }
      : {
          left: `${(pointer.x / DESKTOP_WIDTH) * 100}%`,
          top: `${(pointer.y / DESKTOP_HEIGHT) * 100}%`
        }
    : undefined

  return (
    <section className="stage" ref={stageRef}>
      <header className="stage-header">
        <div className="stage-title">
          <span className="stage-mark" aria-hidden="true">
            <Icon name="terminal" size={15} />
          </span>
          <div className="stage-title-text">
            <h2>{t('runtimeTitle')}</h2>
            <span className="stage-sub">
              {t(PHASE_KEYS[phase])}
              <span className="stage-sep">·</span>
              {runtime.cpus} CPU
              <span className="stage-sep">·</span>
              {Math.round(runtime.memoryMB / 1024)} GB
            </span>
          </div>
          <span className={`stage-dot ${phase === 'running' ? 'online' : ''}`} />
        </div>

        <div className="stage-actions">
          {runtime.warning ? (
            <span className="stage-warning" title={runtime.warning}>
              <Icon name="alert" size={14} />
            </span>
          ) : null}
          {phase === 'running' || phase === 'stopped' || phase === 'error' ? (
            phase === 'running' ? (
              <button type="button" className="stage-button" onClick={props.onStop} title={t('stop')}>
                <Icon name="stop" size={12} />
                <span>{t('stop')}</span>
              </button>
            ) : (
              <button type="button" className="stage-button primary" onClick={props.onStart} title={t('start')}>
                <Icon name="play" size={12} />
                <span>{t('start')}</span>
              </button>
            )
          ) : null}
          <button
            type="button"
            className="icon-button stage-icon"
            onClick={props.onRestart}
            title={t('restart')}
            disabled={phase === 'preparing' || phase === 'downloading-image' || phase === 'creating-disk'}
          >
            <Icon name="restart" />
          </button>
          <div className="clipboard-wrap">
            <button
              type="button"
              className="icon-button stage-icon"
              onClick={() => setClipboardOpen((value) => !value)}
              title={t('paste')}
            >
              <Icon name="clipboard" />
            </button>
          </div>
          <button type="button" className="icon-button stage-icon" onClick={toggleFullscreen} title={fullscreen ? t('exitFullscreen') : t('fullscreen')}>
            <Icon name={fullscreen ? 'minimize' : 'maximize'} />
          </button>
          <button type="button" className="icon-button stage-icon" onClick={() => void openLogs()} title={t('logs')}>
            <Icon name="terminal" />
          </button>
        </div>
      </header>

      <div className="desktop-shell">
        <div className="desktop-host" ref={hostRef} />

        {screen === 'connected' && hintVisible ? (
          <div className="desktop-hint">
            <span className="mouse-shape" />
            {t('clickToInteract')}
          </div>
        ) : null}

        {aiWorking ? (
          <div className="ai-activity" aria-live="polite">
            <span className="ai-spark" />
            <span className="ai-activity-label">{t('aiWorking')}</span>
            <span className="ai-activity-text">{task.activity ?? t('working')}</span>
          </div>
        ) : null}

        {pointerFresh ? (
          <div
            className="ai-pointer"
            style={pointerStyle}
            aria-hidden="true"
          >
            <span className="ai-pointer-ring" />
            <span className="ai-pointer-label">AI</span>
          </div>
        ) : null}

        {phase !== 'running' ? (
          <RuntimeOverlay
            t={t}
            runtime={runtime}
            onStart={props.onStart}
            onRestart={props.onRestart}
            onOpenLogs={props.onOpenLogs}
          />
        ) : null}

        {phase === 'running' && (screen === 'connecting' || screen === 'lost' || screenError) ? (
          <div className="desktop-connection">
            <span className="mini-spin light" />
            <span>{screenError ?? (screen === 'lost' ? t('connectionLost') : t('connectingDesktop'))}</span>
            {screen === 'lost' ? (
              <button type="button" className="link-button light" onClick={props.onRestart}>
                {t('restart')}
              </button>
            ) : null}
          </div>
        ) : null}

        {clipboardOpen ? (
          <div className="clipboard-popover">
            <div className="clipboard-head">
              <span>{t('guestClipboardTitle')}</span>
              <button type="button" className="icon-button" onClick={() => setClipboardOpen(false)}>
                <Icon name="close" size={13} />
              </button>
            </div>
            <p>{guestClipboard ? preview(guestClipboard) : t('guestClipboardEmpty')}</p>
            {clipboardError ? <p className="clipboard-error">{clipboardError}</p> : null}
            <div className="clipboard-actions">
              <button type="button" className="button ghost" onClick={() => void pasteClipboard()}>
                {t('paste')}
              </button>
              <button
                type="button"
                className="button solid"
                onClick={() => void copyGuestClipboard()}
                disabled={!guestClipboard}
              >
                {t('copyGuestClipboard')}
              </button>
            </div>
          </div>
        ) : null}
      </div>

      {logsOpen ? (
        <div className="modal-backdrop" onClick={() => setLogsOpen(false)}>
          <div className="modal logs-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-head">
              <h2>{t('logs')}</h2>
              <button type="button" className="icon-button" onClick={() => setLogsOpen(false)}>
                <Icon name="close" />
              </button>
            </div>
            <p className="modal-sub">{t('showLogsHint')}</p>
            <pre className="logs-output">{logsLoading ? '…' : logs}</pre>
            <div className="modal-actions">
              <button type="button" className="button ghost" onClick={() => void window.tagnest.runtime.openLogFolder()}>
                {t('openLogs')}
              </button>
              <button type="button" className="button solid" onClick={() => setLogsOpen(false)}>
                {t('close')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  )
}

function RuntimeOverlay({
  t,
  runtime,
  onStart,
  onRestart,
  onOpenLogs
}: {
  t: Translate
  runtime: RuntimeState
  onStart: () => void
  onRestart: () => void
  onOpenLogs: () => void
}): JSX.Element {
  const isError = runtime.phase === 'error'
  const isStopped = runtime.phase === 'stopped'
  const showProgress = typeof runtime.progress === 'number' && runtime.progress > 0

  return (
    <div className="runtime-overlay">
      <div className={`runtime-card ${isError ? 'error' : ''}`}>
        {!isError && !isStopped ? <span className="runtime-spinner" /> : null}
        <h2>{isError ? t('errorTitle') : isStopped ? t('runtimeNotRunning') : runtime.message}</h2>
        {isStopped ? <p>{t('runtimeNotRunningHint')}</p> : null}
        {isError ? (
          <>
            <p className="runtime-error-message">{runtime.error?.message}</p>
            {runtime.error?.hint ? <pre className="runtime-hint">{runtime.error.hint}</pre> : null}
          </>
        ) : (
          <p className="runtime-detail">{runtime.detail ?? (isStopped ? t('persistenceNote') : '')}</p>
        )}
        {showProgress ? (
          <div className="progress">
            <div className={`progress-bar ${runtime.progress === 100 ? 'indeterminate' : ''}`} style={{ width: `${runtime.progress}%` }} />
          </div>
        ) : null}
        {isStopped ? <p className="runtime-note">{t('firstRunNote')}</p> : null}
        <div className="runtime-actions">
          {isStopped ? (
            <button type="button" className="button solid" onClick={onStart}>
              {t('start')}
            </button>
          ) : null}
          {isError ? (
            <>
              <button type="button" className="button ghost" onClick={onOpenLogs}>
                {t('logs')}
              </button>
              <button type="button" className="button solid" onClick={onRestart}>
                {t('restart')}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function preview(text: string): string {
  return text.length > 180 ? `${text.slice(0, 180)}…` : text
}
