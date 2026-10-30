import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * Pinned Cloudflare quick-tunnel client. Quick tunnels need no account and no
 * server of your own: the binary connects out to Cloudflare and gives back a
 * random https://….trycloudflare.com address. The app only ever downloads this
 * exact file and verifies its SHA-256 before executing it.
 */
export const CLOUDFLARED = {
  version: '2026.10.6',
  fileName: 'cloudflared.exe',
  url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.6/cloudflared-windows-amd64.exe',
  sha256: 'd521b3bf68982165f0d06d76732f22d9a105ef057ff3ae4c0986f3a23190950f',
  bytes: 55_390_656
} as const

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

export type TunnelProgress = (percent: number) => void

export function cloudflaredPath(toolsDir: string): string {
  return join(toolsDir, CLOUDFLARED.fileName)
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Downloads (or resumes) the tunnel client and verifies the pinned digest.
 * A failed download keeps its `.part` file; the next attempt continues.
 */
export async function ensureCloudflared(
  toolsDir: string,
  onProgress: TunnelProgress = () => undefined,
  signal?: AbortSignal
): Promise<string> {
  const override = process.env.TAGNEST_CLOUDFLARED
  if (override && existsSync(override)) return override

  mkdirSync(toolsDir, { recursive: true })
  const target = cloudflaredPath(toolsDir)
  if (existsSync(target)) {
    if ((await sha256File(target)) === CLOUDFLARED.sha256) {
      onProgress(100)
      return target
    }
    unlinkSync(target)
  }

  const partial = `${target}.part`
  let start = existsSync(partial) ? statSync(partial).size : 0
  if (start > CLOUDFLARED.bytes) {
    unlinkSync(partial)
    start = 0
  }
  const hash = createHash('sha256')
  if (start > 0) {
    for await (const chunk of createReadStream(partial)) hash.update(chunk as Buffer)
  }

  const response = await fetch(CLOUDFLARED.url, {
    redirect: 'follow',
    headers: start > 0 ? { Range: `bytes=${start}-` } : {},
    ...(signal ? { signal } : {})
  }).catch((error: unknown) => {
    throw new Error(
      `Could not reach GitHub to download the tunnel helper (${describe(error)}). Check the internet connection or choose Home network / Custom URL.`
    )
  })
  if (!response.ok) {
    throw new Error(`The tunnel helper download failed with HTTP ${response.status}. Try again, or use Home network / Custom URL.`)
  }
  const resumed = start > 0 && response.status === 206
  if (start > 0 && !resumed) start = 0
  if (!response.body) throw new Error('The tunnel helper download returned an empty response.')

  const total = CLOUDFLARED.bytes
  let received = start
  onProgress(Math.round((received / total) * 100))
  const file = createWriteStream(partial, { flags: resumed ? 'a' : 'w', mode: 0o755 })
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length
      onProgress(Math.min(99, Math.round((received / total) * 100)))
      callback(null, chunk)
    }
  })

  try {
    await pipeline(
      Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
      hasher,
      file,
      signal ? { signal } : {}
    )
  } catch (error) {
    // Keep the partial file: a later attempt resumes instead of restarting.
    throw new Error(`The tunnel helper download was interrupted (${describe(error)}). Start remote access again to resume.`)
  }

  const digest = hash.digest('hex')
  if (digest !== CLOUDFLARED.sha256) {
    try {
      unlinkSync(partial)
    } catch {
      /* ignore */
    }
    throw new Error('The downloaded tunnel helper failed its checksum. It was deleted; try again.')
  }
  const { renameSync } = await import('node:fs')
  renameSync(partial, target)
  onProgress(100)
  return target
}

export interface QuickTunnelOptions {
  onLog?: (line: string) => void
  onExit?: (message: string) => void
}

/**
 * Runs `cloudflared tunnel --url http://127.0.0.1:<port>` and reports the public
 * URL Cloudflare assigns. No Cloudflare account or configuration is involved.
 */
export class QuickTunnel {
  private child: ChildProcess | null = null
  private url: string | null = null
  private exited = false

  async start(binary: string, port: number, options: QuickTunnelOptions = {}): Promise<string> {
    if (this.child) throw new Error('The tunnel is already running.')
    const output: string[] = []
    const child = spawn(
      binary,
      ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--loglevel', 'info'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    this.child = child
    this.exited = false

    const url = await new Promise<string>((resolve, reject) => {
      let settled = false
      const finish = (result: string | Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (result instanceof Error) {
          this.stop().catch(() => undefined)
          reject(result)
        } else {
          resolve(result)
        }
      }
      const remember = (chunk: Buffer): void => {
        const text = chunk.toString('utf8').replace(ANSI_PATTERN, '')
        options.onLog?.(text.trim())
        output.push(text)
        while (output.join('').length > 6000) output.shift()
        const match = URL_PATTERN.exec(text)
        if (match) {
          this.url = match[0]
          finish(match[0])
        }
      }
      child.stdout?.on('data', remember)
      child.stderr?.on('data', remember)
      child.once('error', (error) => finish(new Error(`Could not start the tunnel helper: ${error.message}`)))
      child.once('exit', (code) => {
        this.exited = true
        this.child = null
        const details = output.join('').trim().split('\n').slice(-6).join(' ')
        if (!settled) {
          finish(
            new Error(
              `The tunnel helper exited before it was ready (code ${code ?? 'unknown'}). ${
                details ? `Cloudflare said: ${details}` : 'Check the internet connection and try again.'
              }`
            )
          )
          return
        }
        this.url = null
        options.onExit?.(
          details
            ? `The public tunnel closed. ${details}`
            : 'The public tunnel closed. Start remote access again to get a new address.'
        )
      })
      const timer = setTimeout(() => {
        finish(new Error('The tunnel did not become ready within 60 seconds. Try again, or use Home network / Custom URL.'))
      }, 60_000)
    })
    return url
  }

  getUrl(): string | null {
    return this.url
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.url = null
    if (!child || child.exitCode !== null || this.exited) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          // /T also ends cloudflared's own edge connections; /F is required
          // because Windows has no graceful SIGTERM for a console process.
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).once('exit', () =>
            resolve()
          )
        } catch {
          resolve()
        }
      }, 2500)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        child.kill()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
