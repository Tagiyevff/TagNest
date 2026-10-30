import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AutoUpdateState } from '../shared/types'
import { logger } from './logger'

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 10_000

/**
 * Downloads published GitHub releases with electron-updater and applies them on
 * restart. Only packaged Windows builds participate: a development checkout has
 * no update feed, and other platforms are not packaged yet.
 */
export class AutoUpdateController {
  private state: AutoUpdateState
  private readonly listeners = new Set<(state: AutoUpdateState) => void>()
  private started = false
  private checkInFlight = false
  private firstTimer: NodeJS.Timeout | null = null
  private intervalTimer: NodeJS.Timeout | null = null

  constructor(private readonly currentVersion: string) {
    this.state = {
      status: 'idle',
      current: currentVersion
    }
  }

  getState(): AutoUpdateState {
    return { ...this.state }
  }

  onState(listener: (state: AutoUpdateState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (!app.isPackaged || process.platform !== 'win32') {
      this.set({
        status: 'disabled',
        current: this.currentVersion,
        message: app.isPackaged
          ? 'Automatic updates are currently available in the Windows build.'
          : 'Automatic updates are active in the installed build.'
      })
      return
    }

    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => {
      this.set({ status: 'checking', message: 'Checking for a new version…' })
    })
    autoUpdater.on('update-available', (info) => {
      this.set({
        status: 'available',
        version: info.version,
        message: `TagNest ${info.version} is available and downloading…`
      })
    })
    autoUpdater.on('update-not-available', () => {
      this.set({ status: 'up-to-date', message: 'You are running the latest version.' })
    })
    autoUpdater.on('download-progress', (progress) => {
      this.set({
        status: 'downloading',
        percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
        message: `Downloading TagNest ${this.state.version ?? ''}…`
      })
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.set({
        status: 'ready',
        version: info.version,
        percent: 100,
        message: `TagNest ${info.version} is ready to install.`
      })
    })
    autoUpdater.on('error', (error) => {
      logger.warn('updates', 'automatic update failed', error)
      this.set({
        status: 'error',
        message: friendlyUpdateError(error)
      })
    })

    this.firstTimer = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.intervalTimer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  async check(): Promise<AutoUpdateState> {
    if (this.state.status === 'disabled') return this.getState()
    if (this.checkInFlight || this.state.status === 'downloading') return this.getState()
    this.checkInFlight = true
    this.set({ status: 'checking', message: 'Checking for a new version…' })
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      logger.warn('updates', 'update check could not run', error)
      this.set({ status: 'error', message: friendlyUpdateError(error) })
    } finally {
      this.checkInFlight = false
    }
    return this.getState()
  }

  /** Applies a downloaded update by quitting; the installer runs on quit. */
  install(): void {
    if (this.state.status !== 'ready') return
    logger.info('updates', `installing TagNest ${this.state.version ?? ''}`)
    app.quit()
  }

  dispose(): void {
    if (this.firstTimer) clearTimeout(this.firstTimer)
    if (this.intervalTimer) clearInterval(this.intervalTimer)
    this.firstTimer = null
    this.intervalTimer = null
    this.listeners.clear()
  }

  private set(patch: Partial<AutoUpdateState>): void {
    this.state = { ...this.state, ...patch, current: this.currentVersion }
    for (const listener of this.listeners) listener(this.getState())
  }
}

export function friendlyUpdateError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/net::|ENOTFOUND|ECONN|ETIMEDOUT|network/i.test(message)) {
    return 'The update server could not be reached. Check your internet connection and try again.'
  }
  if (/latest\.yml|404|not found/i.test(message)) {
    return 'This release has no automatic update file yet. Download the installer from the Releases page.'
  }
  if (/code signature|signature/i.test(message)) {
    return 'The downloaded update failed its signature check and was discarded.'
  }
  return message.length > 300 ? `${message.slice(0, 297)}…` : message
}
