import { spawn, spawnSync } from 'node:child_process'
import { logger } from '../logger'
import { findQemuBinary, resetQemuCache } from './qemu'

/**
 * Installs QEMU on Windows through winget. The installer is machine-wide, so
 * Windows shows its own UAC prompt; TagNest never bypasses that prompt and
 * never runs anything with elevated rights on its own. Only a fixed package ID
 * is passed, so no user input reaches the elevated command.
 */
const WINGET_ID = 'SoftwareFreedomConservancy.QEMU'
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000

export function hasWinget(): boolean {
  if (process.platform !== 'win32') return false
  const result = spawnSync('where.exe', ['winget'], { encoding: 'utf8', windowsHide: true })
  return result.status === 0 && result.stdout.trim().length > 0
}

export function canAutoInstallQemu(): boolean {
  return process.platform === 'win32' && hasWinget()
}

export interface QemuInstallResult {
  ok: boolean
  message: string
}

export async function installQemu(
  onStatus: (message: string) => void = () => undefined
): Promise<QemuInstallResult> {
  if (process.platform !== 'win32') {
    return { ok: false, message: 'Automatic QEMU installation is only available on Windows.' }
  }
  if (!hasWinget()) {
    return {
      ok: false,
      message:
        'winget is not available on this computer. Install QEMU from https://qemu.weilnetz.de/w64/ or install App Installer from the Microsoft Store.'
    }
  }

  onStatus('Windows is asking for permission to install QEMU…')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath 'winget.exe' -ArgumentList @('install','--id','${WINGET_ID}','-e','--accept-package-agreements','--accept-source-agreements','--disable-interactivity') -Verb RunAs -Wait -PassThru`,
    '  Write-Output ("EXIT=" + $p.ExitCode)',
    '  exit $p.ExitCode',
    '} catch {',
    '  Write-Output ("ERROR=" + $_.Exception.Message)',
    '  exit 1',
    '}'
  ].join('\n')

  const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, INSTALL_TIMEOUT_MS)
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
        if (stdout.length > 20_000) stdout = stdout.slice(-20_000)
      })
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000)
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolve({ code, stdout, stderr, timedOut })
      })
    }
  )

  if (result.timedOut) {
    return { ok: false, message: 'The QEMU installation did not finish within 15 minutes.' }
  }
  const cancelled = /canceled by the user|operation was canceled/i.test(`${result.stdout}\n${result.stderr}`)
  const failureDetail = /ERROR=(.+)/.exec(result.stdout)?.[1]?.trim()
  if (cancelled) {
    return { ok: false, message: 'The Windows permission prompt was cancelled, so QEMU was not installed.' }
  }
  if (result.code !== 0) {
    const detail = failureDetail || result.stderr.trim().slice(-400) || result.stdout.trim().slice(-400)
    logger.warn('qemu', `winget installer exited with ${result.code ?? 'no code'}`, detail)
    return {
      ok: false,
      message: `winget could not install QEMU (exit ${result.code ?? 'unknown'}).${detail ? ` ${detail}` : ''}`
    }
  }

  onStatus('QEMU installed. Checking the emulator…')
  resetQemuCache()
  const binary = findQemuBinary()
  if (!binary) {
    return {
      ok: false,
      message:
        'winget reported success, but qemu-system-x86_64 was not found. Restart TagNest, or install QEMU manually from https://qemu.weilnetz.de/w64/.'
    }
  }
  logger.info('qemu', `QEMU installed at ${binary}`)
  return { ok: true, message: `QEMU is ready at ${binary}.` }
}
