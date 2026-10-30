import { app, BrowserWindow, Menu, nativeImage, powerSaveBlocker, session, shell, Tray } from 'electron'
import { join } from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { AgentRuntime } from './agent/agent'
import { AutoUpdateController } from './auto-update'
import { registerIpc } from './ipc'
import { LinuxRuntime } from './linux/runtime'
import { applyLaunchAtLogin } from './login-item'
import { logger } from './logger'
import { RemoteAccess } from './remote/remote'
import { ConversationStore } from './storage/conversations'
import { SecretsStore } from './storage/secrets'
import { SettingsStore } from './storage/settings'

let mainWindow: BrowserWindow | null = null
let runtime: LinuxRuntime | null = null
let agent: AgentRuntime | null = null
let updates: AutoUpdateController | null = null
let remote: RemoteAccess | null = null
let tray: Tray | null = null
let sleepBlocker: number | null = null
let quitting = false
let trayHintShown = false

app.setName('TagNest')

// A single failed guest connection must never take the whole app down with
// Electron's default uncaught-exception dialog. Log it and keep the runtime
// state machine in charge of reporting the failure in the UI.
process.on('uncaughtException', (error) => {
  logger.error('app', 'uncaught exception', error)
})
process.on('unhandledRejection', (reason) => {
  logger.error('app', 'unhandled rejection', reason)
})

function showMainWindow(): void {
  if (!mainWindow) return
  mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // A second launch must only wake the existing window. Registering
  // whenReady here as well would briefly start a duplicate remote server and
  // tray before this process exits.
  app.quit()
} else {
  app.on('second-instance', () => {
    showMainWindow()
  })

  app.whenReady().then(async () => {
  const userDataDir = app.getPath('userData')
  mkdirSync(userDataDir, { recursive: true })
  logger.init(userDataDir)
  logger.info('app', `TagNest ${app.getVersion()} starting (${process.platform}, Electron ${process.versions.electron})`)

  const secrets = new SecretsStore(userDataDir)
  const settings = new SettingsStore(userDataDir, secrets)
  const conversations = new ConversationStore(userDataDir)
  applyLaunchAtLogin(settings.get().launchAtLogin)

  runtime = new LinuxRuntime(userDataDir, () => settings.get())
  agent = new AgentRuntime(conversations, settings, secrets, runtime)
  updates = new AutoUpdateController(app.getVersion())
  remote = new RemoteAccess({
    userDataDir,
    runtime,
    agent,
    conversations,
    version: app.getVersion(),
    novncDir: join(app.getAppPath(), 'node_modules/@novnc/novnc')
  })

  mainWindow = createWindow()
  tray = createTray()
  registerIpc({
    window: mainWindow,
    settings,
    secrets,
    conversations,
    runtime,
    agent,
    updates,
    remote
  })
  updates.start()
  // Keep Windows awake while phone access is live. The display may still turn
  // off; the VM and the server keep running. Closing the lid can still sleep a
  // laptop depending on its power plan.
  remote.onState((state) => {
    tray?.setContextMenu(buildTrayMenu())
    const shouldBlock = state.enabled && state.phase === 'running'
    if (shouldBlock && sleepBlocker === null) {
      sleepBlocker = powerSaveBlocker.start('prevent-app-suspension')
      logger.info('app', 'phone access is on; system sleep is blocked')
    } else if (!shouldBlock && sleepBlocker !== null) {
      powerSaveBlocker.stop(sleepBlocker)
      sleepBlocker = null
      logger.info('app', 'phone access is off; system sleep is allowed again')
    }
  })
  // Reconnect a phone after an app restart without asking the user to touch
  // Settings again. This runs in the background; failures stay visible there.
  void remote.restore().catch((error) => logger.error('app', 'remote access restore failed', error))

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.once('did-finish-load', () => {
    if (settings.get().autoStartLinux) {
      logger.info('app', 'auto-starting the Linux environment')
      void runtime?.start()
    }
    void maybeCaptureScreenshot()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      tray = createTray()
    } else {
      showMainWindow()
    }
  })
  })
}

/** The TagNest app icon: bundled next to the app in production, build/ in development. */
function findAppIcon(): string | undefined {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'icon.png') : '',
    join(__dirname, '../../build/icon.png')
  ].filter(Boolean)
  return candidates.find((candidate) => existsSync(candidate))
}

function buildTrayMenu(): Menu {
  const remoteState = remote?.getState()
  return Menu.buildFromTemplate([
    { label: 'Show TagNest', click: showMainWindow },
    {
      label:
        remoteState?.enabled && remoteState.phase === 'running'
          ? `Phone access: on${remoteState.url ? ` (${hostOf(remoteState.url)})` : ''}`
          : 'Phone access: off',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Quit TagNest',
      // before-quit owns shutdown: it stops the agent, the remote server, the
      // tunnel and QEMU. Setting quitting here would make it skip that cleanup.
      click: () => app.quit()
    }
  ])
}

function hostOf(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

function createTray(): Tray | null {
  const iconPath = findAppIcon()
  if (!iconPath) {
    logger.warn('app', 'tray disabled: no app icon found')
    return null
  }
  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    logger.warn('app', `tray disabled: icon is empty (${iconPath})`)
    return null
  }
  const size = image.getSize()
  logger.info('app', `tray icon: ${iconPath} (${size.width}x${size.height})`)
  const instance = new Tray(image.resize({ width: 20, height: 20 }))
  instance.setToolTip('TagNest')
  instance.setContextMenu(buildTrayMenu())
  instance.on('double-click', showMainWindow)
  logger.info('app', 'tray created')
  return instance
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    show: false,
    title: 'TagNest',
    icon: findAppIcon(),
    backgroundColor: '#e8ecef',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: process.env.TAGNEST_DEVTOOLS === '1' || !app.isPackaged
    }
  })

  window.on('close', (event) => {
    logger.info(
      'app',
      `window close requested (quitting=${quitting}, remote=${Boolean(remote?.getState().enabled)}, tray=${Boolean(tray)})`
    )
    if (quitting) return
    // With phone access on, closing the window should not cut the phone off.
    // Keep the app in the tray instead; the tray menu can show it or quit.
    if (remote?.getState().enabled && tray) {
      event.preventDefault()
      window.hide()
      if (!trayHintShown) {
        trayHintShown = true
        try {
          tray.displayBalloon({
            title: 'TagNest is still running',
            content: 'Phone access stays on. Use the tray icon to show or quit TagNest.'
          })
        } catch {
          /* balloons are best-effort on Windows */
        }
      }
    }
  })

  window.on('closed', () => {
    mainWindow = null
  })

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'])
    callback(webContents.id === window.webContents.id && allowed.has(permission))
  })

  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error('app', `preload failed: ${preloadPath}`, error)
  })

  window.setMenuBarVisibility(false)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL
    if (allowed && url.startsWith(allowed)) return
    event.preventDefault()
  })

  if (!app.isPackaged) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*"
          ]
        }
      })
    })
  } else {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'"
          ]
        }
      })
    })
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void window.loadURL(devUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

async function maybeCaptureScreenshot(): Promise<void> {
  const arg = process.argv.find((value) => value.startsWith('--screenshot='))
  if (!arg) return
  const target = arg.slice('--screenshot='.length)
  const delayMs = Number(process.env.TAGNEST_SCREENSHOT_DELAY ?? 9000)
  await new Promise((resolve) => setTimeout(resolve, delayMs))
  if (!mainWindow) return
  try {
    const image = await mainWindow.webContents.capturePage()
    writeFileSync(target, image.toPNG())
    logger.info('app', `screenshot written to ${target}`)
  } catch (error) {
    logger.error('app', 'screenshot failed', error)
  } finally {
    app.quit()
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting) return
  if (!runtime) return
  event.preventDefault()
  quitting = true
  logger.info('app', 'shutting down')
  agent?.dispose()
  updates?.dispose()
  if (sleepBlocker !== null) powerSaveBlocker.stop(sleepBlocker)
  void remote?.dispose().catch((error) => logger.error('app', 'remote shutdown failed', error))
  runtime
    .dispose()
    .catch((error) => logger.error('app', 'runtime shutdown failed', error))
    .finally(() => app.quit())
})
