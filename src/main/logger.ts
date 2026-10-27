import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from './redact'

type Level = 'debug' | 'info' | 'warn' | 'error'

class Logger {
  private dir = ''
  private file = ''
  private verbose = process.env.TAGNEST_DEBUG === '1'

  init(userDataDir: string): void {
    this.dir = join(userDataDir, 'logs')
    this.file = join(this.dir, 'tagnest.log')
    mkdirSync(this.dir, { recursive: true })
    this.info('logger', 'log file opened')
  }

  get path(): string {
    return this.file
  }

  get directory(): string {
    return this.dir
  }

  debug(scope: string, message: string, meta?: unknown): void {
    if (!this.verbose) return
    this.write('debug', scope, message, meta)
  }

  info(scope: string, message: string, meta?: unknown): void {
    this.write('info', scope, message, meta)
  }

  warn(scope: string, message: string, meta?: unknown): void {
    this.write('warn', scope, message, meta)
  }

  error(scope: string, message: string, meta?: unknown): void {
    this.write('error', scope, message, meta)
  }

  /** Tail of the log file, used by the "Open logs" diagnostics in the UI. */
  tail(lines = 200): string {
    try {
      const content = readFileSync(this.file, 'utf8')
      return content.split('\n').slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  private write(level: Level, scope: string, message: string, meta?: unknown): void {
    const safeMessage = redactSecrets(message)
    const suffix = meta === undefined ? '' : ` ${redactSecrets(safeStringify(meta))}`
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${safeMessage}${suffix}`
    if (level === 'error') console.error(line)
    else if (level === 'warn') console.warn(line)
    else console.log(line)
    if (!this.file) return
    try {
      appendFileSync(this.file, `${line}\n`, 'utf8')
    } catch {
      /* logging must never take the app down */
    }
  }
}

function safeStringify(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  try {
    return typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export const logger = new Logger()
