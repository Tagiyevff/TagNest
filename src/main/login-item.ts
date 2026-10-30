import { app } from 'electron'
import { logger } from './logger'

/**
 * Registers (or removes) TagNest from the user's sign-in items. Only packaged
 * builds are touched: a development checkout would register electron.exe
 * without the application path. No administrator rights are involved.
 */
export function applyLaunchAtLogin(enabled: boolean): void {
  if (!app.isPackaged) return
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled
    })
    logger.info('app', `launch at login ${enabled ? 'enabled' : 'disabled'}`)
  } catch (error) {
    logger.warn('app', 'could not update the login item', error)
  }
}
