import { useCallback, useEffect, useRef, useState, type DragEvent, type JSX } from 'react'
import type RFBType from '@novnc/novnc'
import type { RFBClipboardEvent } from '@novnc/novnc'
import type { GuestStats, RuntimePhase, RuntimeState, TaskState, WorkspaceListing } from '@shared/types'
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
  onInstallQemu: () => void
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
const MAX_DROP_FILES = 200
const MAX_DROP_BYTES = 64 * 1024 * 1024

interface DroppedFile {
  name: string
  relativePath: string
  data: Uint8Array
}

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
  const [stats, setStats] = useState<GuestStats | null>(null)
  const [filesOpen, setFilesOpen] = useState(false)
  const [listing, setListing] = useState<WorkspaceListing | null>(null)
  const [filesBusy, setFilesBusy] = useState(false)
  const [filesError, setFilesError] = useState('')
  const [filesNotice, setFilesNotice] = useState('')
  const [dropActive, setDropActive] = useState(false)
  const dragDepth = useRef(0)

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

  // Live guest readings. Polling only happens while the VM is running and the
  // main process caches results, so this cannot become a busy SSH loop.
  useEffect(() => {
    if (phase !== 'running') return
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const value = await window.tagnest.runtime.stats()
        if (!cancelled) setStats(value)
      } catch {
        if (!cancelled) setStats(null)
      }
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [phase])

  useEffect(() => {
    if (!filesNotice) return
    const timer = setTimeout(() => setFilesNotice(''), 7000)
    return () => clearTimeout(timer)
  }, [filesNotice])

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

  const loadFiles = useCallback(async (path?: string): Promise<void> => {
    setFilesBusy(true)
    setFilesError('')
    try {
      const next = await window.tagnest.files.list(path)
      setListing(next)
    } catch (error) {
      setFilesError(cleanPanelError(error))
    } finally {
      setFilesBusy(false)
    }
  }, [])

  const toggleFiles = (): void => {
    const next = !filesOpen
    setFilesOpen(next)
    // Refresh on every open: the agent may have changed files in the guest
    // since the drawer was last shown.
    if (next) void loadFiles(listing?.path)
  }

  const saveFile = async (path: string): Promise<void> => {
    setFilesError('')
    try {
      const result = await window.tagnest.files.download(path)
      if (result.canceled) return
      if (!result.ok) {
        setFilesError(result.error ?? t('downloadFile'))
        return
      }
      if (result.path) setFilesNotice(t('downloadDone', { path: result.path }))
    } catch (error) {
      setFilesError(cleanPanelError(error))
    }
  }

  const pickUpload = async (): Promise<void> => {
    setFilesBusy(true)
    setFilesError('')
    try {
      const result = await window.tagnest.files.upload({ pick: true })
      if (result.canceled) return
      if (result.uploaded > 0) setFilesNotice(t('copyDone', { count: result.uploaded }))
      if (result.skipped > 0) {
        setFilesError(result.files.find((file) => !file.ok)?.error ?? t('copySkipped', { count: result.skipped }))
      }
      if (listing) await loadFiles(listing.path)
    } catch (error) {
      setFilesError(cleanPanelError(error))
    } finally {
      setFilesBusy(false)
    }
  }

  const dropFiles = async (files: DroppedFile[]): Promise<void> => {
    if (files.length === 0) return
    setFilesBusy(true)
    setFilesError('')
    try {
      const result = await window.tagnest.files.upload({ files })
      if (result.uploaded > 0) setFilesNotice(t('copyDone', { count: result.uploaded }))
      if (result.skipped > 0) {
        setFilesError(result.files.find((file) => !file.ok)?.error ?? t('copySkipped', { count: result.skipped }))
      }
      if (filesOpen) await loadFiles(listing?.path)
    } catch (error) {
      setFilesError(cleanPanelError(error))
    } finally {
      setFilesBusy(false)
    }
  }

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (phase !== 'running' || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    dragDepth.current += 1
    setDropActive(true)
  }

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (phase !== 'running' || !event.dataTransfer.types.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropActive(false)
  }

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (phase !== 'running') return
    event.preventDefault()
    dragDepth.current = 0
    setDropActive(false)
    void (async () => {
      try {
        const files = await collectDroppedFiles(event.dataTransfer)
        await dropFiles(files)
      } catch (error) {
        setFilesError(cleanPanelError(error))
      }
    })()
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

  // Derived, never stored: a stopped VM must not show the last reading.
  const visibleStats = phase === 'running' ? stats : null
  const drawerOpen = filesOpen && phase === 'running'
  const ramPercent = visibleStats ? Math.round((visibleStats.memoryUsedMB / visibleStats.memoryTotalMB) * 100) : null
  const diskPercent = visibleStats ? Math.round((visibleStats.diskUsedGB / visibleStats.diskTotalGB) * 100) : null
  const statsTitle = visibleStats
    ? `${t('statsTitle')} · ${(visibleStats.memoryUsedMB / 1024).toFixed(1)} / ${(
        visibleStats.memoryTotalMB / 1024
      ).toFixed(1)} GB ${t('statsMemory')} · ${visibleStats.diskUsedGB.toFixed(1)} / ${visibleStats.diskTotalGB.toFixed(
        0
      )} GB ${t('statsDisk')} · ${t('statsLoad')} ${visibleStats.load1.toFixed(2)}`
    : undefined

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
              {ramPercent !== null && diskPercent !== null ? (
                <>
                  <span className="stage-sep">·</span>
                  <span className="stage-stats" title={statsTitle}>
                    {t('statsMemory')} {ramPercent}%
                    <span className="stage-sep">·</span>
                    {t('statsDisk')} {diskPercent}%
                  </span>
                </>
              ) : null}
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
          <button
            type="button"
            className="icon-button stage-icon"
            onClick={toggleFiles}
            title={t('filesTitle')}
            disabled={phase !== 'running'}
          >
            <Icon name="folder" />
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

      <div
        className="desktop-shell"
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="desktop-host" ref={hostRef} />

        {dropActive ? (
          <div className="drop-overlay" aria-live="polite">
            <span className="drop-mark">
              <Icon name="upload" size={22} />
            </span>
            <strong>{t('dropTitle')}</strong>
            <span>{t('dropHint')}</span>
            <small>{t('dropLimit', { count: MAX_DROP_FILES, size: Math.round(MAX_DROP_BYTES / 1024 / 1024) })}</small>
          </div>
        ) : null}

        {filesNotice || filesError ? (
          <div className={`panel-toast ${filesError ? 'error' : ''}`}>{filesError || filesNotice}</div>
        ) : null}

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
            onInstallQemu={props.onInstallQemu}
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

        {drawerOpen ? (
          <aside className="files-drawer" aria-label={t('filesTitle')}>
            <div className="files-head">
              <div className="files-head-text">
                <strong>{t('filesTitle')}</strong>
                <span className="files-path" title={listing?.path ?? '~/workspace'}>
                  {listing?.relative ? `~/workspace/${listing.relative}` : '~/workspace'}
                </span>
              </div>
              <button type="button" className="icon-button files-close" onClick={() => setFilesOpen(false)}>
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="files-toolbar">
              <button
                type="button"
                className="button ghost files-tool"
                disabled={!listing?.parent || filesBusy}
                onClick={() => void loadFiles(listing?.parent ?? undefined)}
              >
                <Icon name="chevron" size={12} /> {t('parentFolder')}
              </button>
              <button type="button" className="button ghost files-tool" disabled={filesBusy} onClick={() => void pickUpload()}>
                <Icon name="upload" size={12} /> {t('uploadFiles')}
              </button>
              {filesBusy ? <span className="mini-spin dark" /> : null}
            </div>
            {filesError ? <p className="files-error">{filesError}</p> : null}
            <div className="files-list">
              {!listing && !filesError ? <p className="files-empty">{t('filesEmpty')}</p> : null}
              {listing && listing.entries.length === 0 ? <p className="files-empty">{t('filesEmpty')}</p> : null}
              {listing?.entries.map((entry) => (
                <div key={entry.path} className={`file-row ${entry.type === 'directory' ? 'is-dir' : ''}`}>
                  <button
                    type="button"
                    className="file-open"
                    title={entry.type === 'directory' ? entry.name : t('downloadFile')}
                    onClick={() => {
                      if (entry.type === 'directory') void loadFiles(entry.path)
                      else void saveFile(entry.path)
                    }}
                  >
                    <span className="file-icon">
                      <Icon name={entry.type === 'directory' ? 'folder' : 'file'} size={13} />
                    </span>
                    <span className="file-name">{entry.name}</span>
                    <span className="file-meta">
                      {entry.type === 'directory' ? '' : formatBytes(entry.size)}
                    </span>
                  </button>
                  {entry.type === 'directory' ? null : (
                    <button
                      type="button"
                      className="file-download"
                      title={t('downloadFile')}
                      onClick={() => void saveFile(entry.path)}
                    >
                      <Icon name="download" size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="files-foot">{t('uploadHint')}</p>
          </aside>
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
  onOpenLogs,
  onInstallQemu
}: {
  t: Translate
  runtime: RuntimeState
  onStart: () => void
  onRestart: () => void
  onOpenLogs: () => void
  onInstallQemu: () => void
}): JSX.Element {
  const isError = runtime.phase === 'error'
  const isStopped = runtime.phase === 'stopped'
  const showProgress = typeof runtime.progress === 'number' && runtime.progress > 0
  const showQemuInstall = !runtime.qemuFound && runtime.qemuCanInstall && (isStopped || isError)

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
        {showQemuInstall ? (
          <div className="qemu-install">
            <p>{t('qemuInstallHint')}</p>
            <div className="qemu-install-actions">
              <button
                type="button"
                className="button solid"
                onClick={onInstallQemu}
                disabled={runtime.qemuInstalling}
              >
                {runtime.qemuInstalling ? t('qemuInstalling') : t('qemuInstall')}
              </button>
              {runtime.qemuInstalling ? <span className="mini-spin dark" /> : null}
            </div>
            {runtime.qemuInstallMessage ? <p className="runtime-note">{runtime.qemuInstallMessage}</p> : null}
            <p className="runtime-note">{t('qemuInstallManual')}</p>
          </div>
        ) : null}
        {runtime.qemuFound && runtime.qemuInstallMessage ? (
          <p className="runtime-note">{runtime.qemuInstallMessage}</p>
        ) : null}
        <div className="runtime-actions">
          {isStopped ? (
            <button type="button" className="button solid" onClick={onStart} disabled={runtime.qemuInstalling}>
              {t('start')}
            </button>
          ) : null}
          {isError ? (
            <>
              <button type="button" className="button ghost" onClick={onOpenLogs}>
                {t('logs')}
              </button>
              <button type="button" className="button solid" onClick={onRestart} disabled={runtime.qemuInstalling}>
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${unit === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function cleanPanelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        next()
      }, reject)
    }
    next()
  })
}

/**
 * Reads a drag & drop payload in the renderer and returns plain bytes. No host
 * path ever reaches the main process, so the renderer cannot ask it to read an
 * arbitrary file by name.
 */
async function collectDroppedFiles(dataTransfer: DataTransfer): Promise<DroppedFile[]> {
  const files: DroppedFile[] = []
  let bytes = 0

  const pushFile = async (file: File, relativePath: string): Promise<void> => {
    if (files.length >= MAX_DROP_FILES) {
      throw new Error(`Too many files: drop at most ${MAX_DROP_FILES} at once.`)
    }
    const data = new Uint8Array(await file.arrayBuffer())
    bytes += data.byteLength
    if (bytes > MAX_DROP_BYTES) {
      throw new Error(
        `The drop is larger than ${Math.round(MAX_DROP_BYTES / 1024 / 1024)} MB. Use the Upload button for big files.`
      )
    }
    files.push({ name: file.name, relativePath, data })
  }

  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        ;(entry as FileSystemFileEntry).file(resolve, reject)
      })
      await pushFile(file, prefix ? `${prefix}/${file.name}` : file.name)
      return
    }
    if (!entry.isDirectory) return
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
    for (const child of children) {
      await walk(child, prefix ? `${prefix}/${entry.name}` : entry.name)
    }
  }

  const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === 'file')
  for (const item of items) {
    const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.()
    if (entry) {
      await walk(entry, '')
      continue
    }
    const file = item.getAsFile()
    if (file) await pushFile(file, file.name)
  }
  if (items.length === 0) {
    for (const file of Array.from(dataTransfer.files)) await pushFile(file, file.name)
  }
  return files
}
