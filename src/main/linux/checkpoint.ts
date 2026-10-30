import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { logger } from '../logger'

/**
 * Restore points are disk-only qcow2 snapshots. RAM snapshots (`savevm`) are
 * not available with the WHPX accelerator: QEMU refuses with "State blocked
 * due to missing dirty memory tracking support". The workspace files are what
 * matters, so a restore point starts a fresh qcow2 overlay on top of the
 * current disk. Writes go to the new overlay; rolling back throws the overlay
 * away and boots the untouched parent. Keeping the changes commits the overlay
 * into the parent and removes it.
 */
export const CHECKPOINT_FILE = 'checkpoint.json'
export const CHECKPOINT_DIR = 'checkpoints'

export interface CheckpointMeta {
  /** New overlay that receives writes made after the restore point. */
  overlay: string
  /** The disk the overlay is based on. */
  parent: string
  createdAt: number
}

/** Absolute file name for a new restore-point overlay. */
export function checkpointOverlayName(now = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `restore-${stamp}.qcow2`
}

/** Reads persisted metadata, refusing entries whose overlay no longer exists. */
export function validCheckpoint(
  raw: unknown,
  exists: (path: string) => boolean
): CheckpointMeta | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<CheckpointMeta>
  if (typeof value.overlay !== 'string' || !value.overlay) return null
  if (typeof value.parent !== 'string' || !value.parent) return null
  if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return null
  if (!exists(value.overlay)) return null
  return { overlay: value.overlay, parent: value.parent, createdAt: value.createdAt }
}

interface PendingCommand {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Minimal QEMU Machine Protocol client over the loopback socket QEMU opens
 * with `-qmp tcp:...`. Only the main process knows the random port.
 */
export class QemuQmp {
  private socket: Socket | null = null
  private buffer = ''
  private nextId = 1
  private ready = false
  private connecting: Promise<void> | null = null
  private greeting: (() => void) | null = null
  private readonly pending = new Map<number, PendingCommand>()

  constructor(private readonly port: number) {}

  async execute<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<T> {
    await this.connect()
    return this.send<T>(command, args, timeoutMs)
  }

  close(): void {
    this.ready = false
    this.greeting = null
    const socket = this.socket
    this.socket = null
    this.buffer = ''
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new Error('The QEMU control connection was closed.'))
    }
    try {
      socket?.destroy()
    } catch {
      /* already closed */
    }
  }

  private async connect(): Promise<void> {
    if (this.ready && this.socket && !this.socket.destroyed) return
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: this.port })
        socket.setEncoding('utf8')
        let greeted = false
        const timer = setTimeout(() => {
          if (greeted) return
          greeted = true
          socket.destroy()
          reject(new Error('The QEMU control socket did not accept a connection.'))
        }, 8000)
        this.greeting = () => {
          if (greeted) return
          greeted = true
          clearTimeout(timer)
          this.socket = socket
          resolve()
        }
        socket.on('data', (chunk: string) => this.onData(chunk))
        socket.on('error', (error) => {
          if (!greeted) {
            greeted = true
            clearTimeout(timer)
            reject(error)
          } else {
            this.fail(error)
          }
        })
        socket.on('close', () => this.fail(new Error('The QEMU control socket closed.')))
      })
      await this.send('qmp_capabilities')
      this.ready = true
    })().finally(() => {
      this.connecting = null
    })
    return this.connecting
  }

  private send<T = unknown>(
    command: string,
    args?: Record<string, unknown>,
    timeoutMs = 60_000
  ): Promise<T> {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('The QEMU control socket is not connected.'))
    }
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`QEMU did not answer "${command}" in time.`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      socket.write(`${JSON.stringify({ execute: command, arguments: args, id })}\n`)
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let newline = this.buffer.indexOf('\n')
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      newline = this.buffer.indexOf('\n')
      if (!line) continue
      let message: {
        QMP?: unknown
        event?: unknown
        id?: number
        return?: unknown
        error?: { desc?: string; class?: string }
      }
      try {
        message = JSON.parse(line) as typeof message
      } catch {
        logger.warn('checkpoint', 'ignoring a malformed QMP line')
        continue
      }
      if (message.QMP) {
        this.greeting?.()
        this.greeting = null
        continue
      }
      if (message.event !== undefined) continue
      if (typeof message.id !== 'number') continue
      const pending = this.pending.get(message.id)
      if (!pending) continue
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) {
        pending.reject(
          new Error(message.error.desc ?? message.error.class ?? 'The QEMU command failed.')
        )
      } else {
        pending.resolve(message.return ?? null)
      }
    }
  }

  private fail(error: Error): void {
    this.ready = false
    this.socket = null
    this.buffer = ''
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(error)
    }
  }
}

/** Merges a restore-point overlay into its parent (keeps the changes). */
export async function commitDiskSnapshot(qemuImg: string, overlay: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(qemuImg, ['commit', overlay], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`qemu-img commit failed (${code}): ${stderr.trim()}`))
    })
  })
}

export async function deleteCheckpointOverlay(path: string): Promise<void> {
  // Windows can keep the qcow2 handle for a moment after QEMU exits, even
  // though the process is gone. Retry briefly instead of failing the restore.
  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      await rm(path, { force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') throw error
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }
  await rm(path, { force: true })
}

export function logCheckpointFailure(action: string, error: unknown): void {
  logger.warn('checkpoint', `${action} failed`, error)
}
