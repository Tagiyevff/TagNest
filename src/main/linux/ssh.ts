import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client, type ConnectConfig, type FileEntry, type SFTPWrapper } from 'ssh2'
import { logger } from '../logger'

export interface ExecOptions {
  cwd?: string
  timeoutMs?: number
  maxBytes?: number
  signal?: AbortSignal
  /** Run through `sh -lc` instead of `sh -c` so profile env is available. */
  login?: boolean
}

export interface ExecResult {
  command: string
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  truncated: boolean
}

export interface RemoteEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | 'other'
  size: number
  modified: number
  mode: number
}

const DEFAULT_MAX_BYTES = 256 * 1024

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/**
 * Thin, promise-based wrapper over a single SSH connection to the guest.
 * The guest exposes sshd only on a loopback port forwarded by QEMU.
 */
export class GuestClient {
  private client: Client | null = null
  private connected = false
  // sshd allows a limited number of channels per connection (MaxSessions,
  // usually 10). Opening a fresh SFTP channel for every file operation used
  // them up and made later calls fail with "Channel open failure", so one
  // session is opened lazily and reused for the whole connection.
  private sftpSession: SFTPWrapper | null = null
  private sftpOpening: Promise<SFTPWrapper> | null = null

  constructor(private readonly keyPath: string) {}

  get isConnected(): boolean {
    return this.connected
  }

  async connect(options: { port: number; username: string; timeoutMs?: number }): Promise<void> {
    await this.disconnect()
    const privateKey = readFileSync(this.keyPath)
    const config: ConnectConfig = {
      host: '127.0.0.1',
      port: options.port,
      username: options.username,
      privateKey,
      readyTimeout: options.timeoutMs ?? 15000,
      keepaliveInterval: 10000,
      keepaliveCountMax: 3,
      tryKeyboard: false
    }
    const client = new Client()
    this.client = client
    // ssh2 may emit more than one 'error' for a failed handshake (the first
    // rejects this promise, the second arrives while the socket closes). Keep
    // a permanent listener so a late error can never become an uncaught
    // exception that takes the Electron main process down.
    client.on('error', (error: Error) => {
      this.connected = false
      logger.debug('ssh', 'connection error', error.message)
    })
    client.on('close', () => {
      this.connected = false
    })

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        cleanup()
        reject(error)
      }
      const onReady = (): void => {
        cleanup()
        resolve()
      }
      const cleanup = (): void => {
        client.off('error', onError)
        client.off('ready', onReady)
      }
      client.once('error', onError)
      client.once('ready', onReady)
      try {
        client.connect(config)
      } catch (error) {
        onError(error as Error)
      }
    }).catch((error: Error) => {
      this.connected = false
      throw error
    })

    this.connected = true
  }

  /** Reads a guest file as raw bytes (used for screenshots). */
  async readBuffer(path: string): Promise<Buffer> {
    const sftp = await this.sftp()
    return new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (error, data) => (error ? reject(error) : resolve(data)))
    })
  }

  async disconnect(): Promise<void> {
    const client = this.client
    this.client = null
    this.connected = false
    this.sftpSession = null
    this.sftpOpening = null
    if (!client) return
    await new Promise<void>((resolve) => {
      client.once('close', () => resolve())
      client.end()
      setTimeout(resolve, 1500)
    })
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const client = this.requireClient()
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    const started = Date.now()
    const cwd = options.cwd ? shellQuote(options.cwd) : '~'
    // Run each command in its own session/process group and record the group
    // leader's PID. Closing an SSH channel alone does not stop the remote
    // process, so cancellation and timeouts kill the whole group explicitly.
    const pidFile = `/tmp/tagnest-exec-${Date.now()}-${randomBytes(4).toString('hex')}.pid`
    const inner =
      `echo $$ > ${pidFile}; ` +
      `${options.login ? `sh -lc ${shellQuote(command)}` : `sh -c ${shellQuote(command)}`}; ` +
      `__tagnest_status=$?; rm -f ${pidFile}; exit $__tagnest_status`
    const wrapped = `cd ${cwd} && exec setsid -w sh -c ${shellQuote(inner)}`

    return new Promise<ExecResult>((resolve, reject) => {
      let settled = false
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false

      client.exec(wrapped, { pty: false }, (error, channel) => {
        if (error) {
          reject(error)
          return
        }

        const append = (target: 'out' | 'err', chunk: Buffer): void => {
          const text = chunk.toString('utf8')
          if (target === 'out') {
            if (Buffer.byteLength(stdout) + chunk.length > maxBytes) {
              stdout += text.slice(0, Math.max(0, maxBytes - Buffer.byteLength(stdout)))
              truncated = true
            } else {
              stdout += text
            }
          } else if (Buffer.byteLength(stderr) < 64 * 1024) {
            stderr += text
          }
        }

        channel.on('data', (chunk: Buffer) => append('out', chunk))
        channel.stderr.on('data', (chunk: Buffer) => append('err', chunk))

        const stopRemote = (): void => {
          this.killProcessGroup(pidFile)
          channel.close()
        }

        const timer = setTimeout(() => {
          timedOut = true
          stopRemote()
        }, options.timeoutMs ?? 120_000)

        const onAbort = (): void => {
          stopRemote()
        }
        if (options.signal?.aborted) onAbort()
        else options.signal?.addEventListener('abort', onAbort, { once: true })

        const finish = (exitCode: number | null): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          options.signal?.removeEventListener('abort', onAbort)
          resolve({
            command,
            exitCode,
            stdout,
            stderr,
            durationMs: Date.now() - started,
            timedOut,
            truncated
          })
        }

        channel.on('exit', (code: number | null) => {
          finish(typeof code === 'number' ? code : null)
        })
        channel.on('close', () => finish(null))
        channel.on('error', (channelError: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          reject(channelError)
        })
      })
    })
  }

  async readFile(path: string, maxBytes = 512 * 1024): Promise<string> {
    const sftp = await this.sftp()
    return new Promise<string>((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      const stream = sftp.createReadStream(path)
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size <= maxBytes) chunks.push(chunk)
        else stream.destroy(new Error(`File is larger than ${maxBytes} bytes`))
      })
      stream.on('error', reject)
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
  }

  async writeFile(path: string, content: string, mode = 0o644): Promise<void> {
    await this.writeBuffer(path, Buffer.from(content, 'utf8'), mode)
  }

  /** Writes raw bytes (drag & drop uploads) through SFTP. */
  async writeBuffer(path: string, data: Buffer, mode = 0o644): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, data, { mode }, (error) => (error ? reject(error) : resolve()))
    })
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(path, mode, (error) => (error ? reject(error) : resolve()))
    })
  }

  /** Copies a host file into the guest with SFTP's fastPut (used by the file bridge). */
  async uploadFile(localPath: string, remotePath: string, mode = 0o644): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(localPath, remotePath, { mode }, (error) => (error ? reject(error) : resolve()))
    })
  }

  /** Copies a guest file to the host (used by the download button). */
  async downloadFile(remotePath: string, localPath: string): Promise<void> {
    const sftp = await this.sftp()
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (error) => (error ? reject(error) : resolve()))
    })
  }

  /** Resolves symlinks inside the guest so path checks cannot be bypassed. */
  async realpath(path: string): Promise<string> {
    const sftp = await this.sftp()
    return new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (error, resolved) => (error ? reject(error) : resolve(resolved)))
    })
  }

  async list(path: string): Promise<RemoteEntry[]> {
    const sftp = await this.sftp()
    const entries = await new Promise<FileEntry[]>((resolve, reject) => {
      sftp.readdir(path, (error, list) => (error ? reject(error) : resolve(list)))
    })
    return entries.map((entry) => {
      const mode = entry.attrs.mode ?? 0
      const isDir = (mode & 0o170000) === 0o040000
      const isLink = (mode & 0o170000) === 0o120000
      return {
        name: entry.filename,
        type: isDir ? 'directory' : isLink ? 'symlink' : 'file',
        size: entry.attrs.size ?? 0,
        modified: (entry.attrs.mtime ?? 0) * 1000,
        mode
      } satisfies RemoteEntry
    })
  }

  async stat(path: string): Promise<RemoteEntry | null> {
    const sftp = await this.sftp()
    return new Promise<RemoteEntry | null>((resolve, reject) => {
      sftp.stat(path, (error, attrs) => {
        if (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /No such file/i.test(error.message)) {
            resolve(null)
          } else {
            reject(error)
          }
          return
        }
        const mode = attrs.mode ?? 0
        const isDir = (mode & 0o170000) === 0o040000
        resolve({
          name: path.split('/').pop() ?? path,
          type: isDir ? 'directory' : 'file',
          size: attrs.size ?? 0,
          modified: (attrs.mtime ?? 0) * 1000,
          mode
        })
      })
    })
  }

  /** Kills the remote process group started for one exec call. */
  private killProcessGroup(pidFile: string): void {
    const client = this.client
    if (!client) return
    try {
      client.exec(
        `if [ -s ${pidFile} ]; then kill -TERM -- -$(cat ${pidFile}) 2>/dev/null || true; fi; rm -f ${pidFile}`,
        () => {
          /* best effort: the channel may already be gone */
        }
      )
    } catch {
      /* the connection itself may be closing */
    }
  }

  private sftp(): Promise<SFTPWrapper> {
    if (this.sftpSession) return Promise.resolve(this.sftpSession)
    if (this.sftpOpening) return this.sftpOpening
    const client = this.requireClient()
    this.sftpOpening = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        this.sftpOpening = null
        if (error) {
          reject(error)
          return
        }
        if (this.client !== client) {
          try {
            sftp.end()
          } catch {
            /* the connection is already gone */
          }
          reject(new Error('The SSH connection closed before SFTP was ready.'))
          return
        }
        this.sftpSession = sftp
        const forget = (): void => {
          if (this.sftpSession === sftp) this.sftpSession = null
        }
        sftp.on('close', forget)
        sftp.on('error', (sftpError: Error) => {
          logger.debug('ssh', 'sftp session error', sftpError.message)
          forget()
        })
        resolve(sftp)
      })
    })
    return this.sftpOpening
  }

  private requireClient(): Client {
    if (!this.client || !this.connected) throw new Error('Not connected to the TagNest Linux guest.')
    return this.client
  }
}
