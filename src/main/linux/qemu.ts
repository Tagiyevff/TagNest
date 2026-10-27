import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger'
import type { Acceleration } from '../../shared/types'

let cachedQemu: string | null = null
let cachedQemuImg: string | null = null

function bundledDirs(): string[] {
  const dirs: string[] = []
  if (process.env.TAGNEST_QEMU_DIR) dirs.push(process.env.TAGNEST_QEMU_DIR)
  if (process.resourcesPath) dirs.push(join(process.resourcesPath, 'qemu'))
  dirs.push(join(process.cwd(), 'resources', 'qemu'))
  return dirs
}

const WINDOWS_INSTALL_DIRS = [
  'C:\\Program Files\\qemu',
  'C:\\Program Files (x86)\\qemu'
]

export function findQemuBinary(): string | null {
  if (cachedQemu) return cachedQemu
  const exe = process.platform === 'win32' ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64'
  const candidates = [
    ...(process.env.TAGNEST_QEMU ? [process.env.TAGNEST_QEMU] : []),
    ...bundledDirs().map((dir) => join(dir, exe)),
    ...(process.platform === 'win32' ? WINDOWS_INSTALL_DIRS.map((dir) => join(dir, exe)) : []),
    '/usr/bin/qemu-system-x86_64',
    '/usr/local/bin/qemu-system-x86_64',
    '/opt/homebrew/bin/qemu-system-x86_64'
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedQemu = candidate
      return candidate
    }
  }
  // Last resort: resolve from PATH.
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], {
    encoding: 'utf8'
  })
  if (which.status === 0) {
    const first = which.stdout.split(/\r?\n/).find((line) => line.trim().length > 0)
    if (first && existsSync(first.trim())) {
      cachedQemu = first.trim()
      return cachedQemu
    }
  }
  return null
}

export function findQemuImgBinary(): string | null {
  if (cachedQemuImg) return cachedQemuImg
  const qemu = findQemuBinary()
  const exe = process.platform === 'win32' ? 'qemu-img.exe' : 'qemu-img'
  const candidates = [
    ...(qemu ? [join(qemu, '..', exe)] : []),
    ...bundledDirs().map((dir) => join(dir, exe)),
    ...(process.platform === 'win32' ? WINDOWS_INSTALL_DIRS.map((dir) => join(dir, exe)) : []),
    '/usr/bin/qemu-img',
    '/usr/local/bin/qemu-img'
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedQemuImg = candidate
      return candidate
    }
  }
  return null
}

/**
 * WHPX is the Windows Hypervisor Platform accelerator. We probe it by asking
 * QEMU to start a tiny paused VM. `-accel help` only lists compiled-in
 * accelerators, which is not the same as the host being able to use them.
 */
export async function probeWhpx(qemuBinary: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return new Promise((resolve) => {
    const child = spawn(
      qemuBinary,
      [
        '-machine',
        'pc',
        '-accel',
        'whpx',
        '-cpu',
        'qemu64',
        '-m',
        '128',
        '-display',
        'none',
        '-nodefaults',
        '-S'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true }
    )
    let stderr = ''
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      child.kill()
      resolve(ok)
    }
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', () => finish(false))
    child.on('exit', () => finish(false))
    setTimeout(() => {
      const failed = /WHPX|could not|failed|error/i.test(stderr)
      if (failed) logger.warn('qemu', 'WHPX probe reported problems', stderr.trim())
      finish(!failed)
    }, 2500)
  })
}

export async function detectAcceleration(qemuBinary: string): Promise<{
  acceleration: Acceleration
  warning?: string
}> {
  if (process.platform === 'win32') {
    const whpx = await probeWhpx(qemuBinary)
    if (whpx) return { acceleration: 'whpx' }
    return {
      acceleration: 'tcg',
      warning:
        'Hardware virtualization is unavailable, so the Linux desktop is running in software emulation. It will be slow. To enable Windows Hypervisor Platform, run "Turn Windows features on or off" as an administrator, enable "Windows Hypervisor Platform" and "Virtual Machine Platform", then reboot.'
    }
  }
  // macOS and Linux both expose a hardware accelerator, but TagNest's
  // first-release packaging targets Windows. We still allow running the
  // runtime elsewhere for development with software emulation.
  if (process.platform === 'darwin') return { acceleration: 'tcg' }
  if (existsSync('/dev/kvm')) return { acceleration: 'whpx', warning: 'Using KVM (Linux host).' }
  return { acceleration: 'tcg' }
}
