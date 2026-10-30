import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import { extname, normalize, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer } from 'ws'
import type { AgentEvent, Conversation, RuntimeState } from '../../shared/types'
import type { AgentRuntime } from '../agent/agent'
import type { LinuxRuntime } from '../linux/runtime'
import type { ConversationStore } from '../storage/conversations'
import { logger } from '../logger'
import { DESKTOP_HTML, DESKTOP_JS, MOBILE_CSS, MOBILE_HTML, MOBILE_JS } from './mobile'
import { RemoteStore } from './store'

const COOKIE_NAME = 'tagnest_remote'
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60
const MAX_BODY_BYTES = 128 * 1024
const PAIRING_WINDOW_MS = 5 * 60 * 1000
const PAIRING_MAX_ATTEMPTS = 12

export interface RemoteServerDeps {
  store: RemoteStore
  runtime: LinuxRuntime
  agent: AgentRuntime
  conversations: ConversationStore
  version: string
  novncDir: string
  /** Called after a phone pairs or forgets itself, so Settings stays accurate. */
  onDevicesChanged?: () => void
}

export interface RemoteServerHandle {
  port: number
  close: () => Promise<void>
}

/**
 * Local HTTP + WebSocket server used by a paired phone. It is bound to
 * loopback for tunnel/custom modes and to the private LAN address only when
 * the user explicitly chooses LAN mode. Every control endpoint (except
 * pairing and health) requires a device token.
 */
export class RemoteServer {
  private server: Server | null = null
  private wss: WebSocketServer | null = null
  private port: number | null = null
  private readonly eventClients = new Set<WebSocket>()
  private readonly unsubscribe: Array<() => void> = []
  private heartbeat: NodeJS.Timeout | null = null
  private broadcastTimer: NodeJS.Timeout | null = null
  private pairingAttempts: number[] = []

  constructor(private readonly deps: RemoteServerDeps) {}

  async start(preferredPort: number, host: string): Promise<RemoteServerHandle> {
    if (this.server) throw new Error('Remote access is already running.')
    const server = createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        logger.error('remote', 'request failed', error)
        if (!response.headersSent) this.json(response, 500, { error: 'Internal server error' })
        else response.end()
      })
    })
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    server.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head))

    let lastError: unknown = null
    for (let offset = 0; offset < 20; offset += 1) {
      const port = preferredPort + offset
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          const onError = (error: NodeJS.ErrnoException): void => {
            server.off('listening', onListening)
            rejectListen(error)
          }
          const onListening = (): void => {
            server.off('error', onError)
            resolveListen()
          }
          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(port, host)
        })
        this.port = port
        lastError = null
        break
      } catch (error) {
        lastError = error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
      }
    }
    if (lastError || this.port === null) {
      server.close()
      throw new Error(
        `No free port was available for remote access (${preferredPort}–${preferredPort + 19}). Close the app using that port and try again.`
      )
    }

    this.server = server
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 })
    this.unsubscribe.push(
      this.deps.runtime.onState(() => this.notify()),
      this.deps.agent.addListener((_event: AgentEvent) => this.notify())
    )
    this.heartbeat = setInterval(() => {
      for (const client of this.eventClients) {
        if (client.readyState !== WebSocket.OPEN) {
          this.eventClients.delete(client)
          continue
        }
        client.ping()
      }
    }, 25_000)
    this.heartbeat.unref?.()

    logger.info('remote', `phone access listening on ${host}:${this.port}`)
    return {
      port: this.port,
      close: () => this.stop()
    }
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off()
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.broadcastTimer) clearTimeout(this.broadcastTimer)
    this.broadcastTimer = null
    for (const client of this.eventClients) {
      try {
        client.close(1001, 'Remote access stopped')
      } catch {
        /* ignore */
      }
    }
    this.eventClients.clear()
    const wss = this.wss
    this.wss = null
    if (wss) {
      await new Promise<void>((resolveClose) => {
        wss.close(() => resolveClose())
        setTimeout(resolveClose, 400)
      })
    }
    const server = this.server
    this.server = null
    this.port = null
    if (!server) return
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose())
      setTimeout(resolveClose, 800)
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://tagnest.local')
    if (!this.allowedOrigin(request)) {
      this.json(response, 403, { error: 'Cross-origin request refused' })
      return
    }
    this.securityHeaders(response)

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      this.send(response, 200, 'text/html; charset=utf-8', MOBILE_HTML)
      return
    }
    if (request.method === 'GET' && url.pathname === '/mobile.js') {
      this.send(response, 200, 'text/javascript; charset=utf-8', MOBILE_JS)
      return
    }
    if (request.method === 'GET' && url.pathname === '/mobile.css') {
      this.send(response, 200, 'text/css; charset=utf-8', MOBILE_CSS)
      return
    }
    if (request.method === 'GET' && url.pathname === '/desktop') {
      this.send(response, 200, 'text/html; charset=utf-8', DESKTOP_HTML)
      return
    }
    if (request.method === 'GET' && url.pathname === '/desktop.js') {
      this.send(response, 200, 'text/javascript; charset=utf-8', DESKTOP_JS)
      return
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      this.json(response, 200, { ok: true, app: 'TagNest', version: this.deps.version })
      return
    }
    if (url.pathname.startsWith('/novnc/')) {
      this.serveNoVnc(url.pathname.slice('/novnc/'.length), response)
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/pair') {
      await this.handlePair(request, response)
      return
    }

    const device = this.authenticate(request)
    if (!device) {
      if (url.pathname === '/vnc') {
        this.json(response, 401, { error: 'Pair this phone first' })
        return
      }
      this.json(response, 401, { error: 'pairing-required' })
      return
    }

    if (request.method === 'GET' && url.pathname === '/api/state') {
      this.deps.store.touch(device.id)
      this.json(response, 200, this.snapshot(device.id))
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/send') {
      const body = await this.readJson(request)
      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (!text || text.length > 20_000) {
        this.json(response, 400, { error: 'The message is empty or too long.' })
        return
      }
      const conversationId = typeof body.conversationId === 'string' ? body.conversationId : undefined
      try {
        const result = await this.deps.agent.send({ text, ...(conversationId ? { conversationId } : {}) })
        this.json(response, 200, { ok: true, conversationId: result.conversationId })
      } catch (error) {
        this.json(response, 409, { error: messageOf(error) })
      }
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/cancel') {
      this.deps.agent.cancel()
      this.json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/approve') {
      const body = await this.readJson(request)
      const pending = this.deps.agent.getPendingApproval()
      if (!pending || body.requestId !== pending.id || typeof body.approved !== 'boolean') {
        this.json(response, 409, { error: 'That approval request is no longer active.' })
        return
      }
      this.deps.agent.respondApproval(pending.id, body.approved)
      this.json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/retry') {
      const body = await this.readJson(request)
      if (typeof body.conversationId !== 'string') {
        this.json(response, 400, { error: 'conversationId is required' })
        return
      }
      try {
        await this.deps.agent.retry(body.conversationId)
        this.json(response, 200, { ok: true })
      } catch (error) {
        this.json(response, 409, { error: messageOf(error) })
      }
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/conversations/new') {
      const conversation = this.deps.conversations.create()
      this.deps.conversations.setActiveId(conversation.id)
      this.notify()
      this.json(response, 200, { conversation })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/conversations/select') {
      const body = await this.readJson(request)
      if (typeof body.id !== 'string' || !this.deps.conversations.get(body.id)) {
        this.json(response, 404, { error: 'That task no longer exists.' })
        return
      }
      this.deps.conversations.setActiveId(body.id)
      this.notify()
      this.json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/runtime/start') {
      const state = this.deps.runtime.getState()
      if (state.phase === 'stopped' || state.phase === 'error') {
        void this.deps.runtime.start().catch((error: unknown) => logger.error('remote', 'remote start failed', error))
      }
      this.json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/runtime/stop') {
      void this.deps.runtime.stop().catch((error: unknown) => logger.error('remote', 'remote stop failed', error))
      this.json(response, 200, { ok: true })
      return
    }
    if (request.method === 'POST' && url.pathname === '/api/device/forget') {
      this.deps.store.revoke(device.id)
      this.deps.onDevicesChanged?.()
      response.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`)
      this.json(response, 200, { ok: true })
      this.notify()
      return
    }

    this.json(response, 404, { error: 'Not found' })
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(request.url ?? '/', 'http://tagnest.local')
    const wss = this.wss
    if (!wss || (url.pathname !== '/events' && url.pathname !== '/vnc')) {
      socket.destroy()
      return
    }
    if (!this.allowedOrigin(request)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    const device = this.authenticate(request)
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      if (url.pathname === '/events') this.attachEvents(client)
      else this.attachDesktop(client)
    })
  }

  private attachEvents(client: WebSocket): void {
    this.eventClients.add(client)
    client.on('close', () => this.eventClients.delete(client))
    client.on('error', () => this.eventClients.delete(client))
    client.on('message', (data) => {
      // Only a keepalive is accepted; no client-controlled state lives here.
      if (data.toString() === 'ping') client.send('pong')
    })
    client.send(JSON.stringify({ type: 'ready', at: Date.now() }))
  }

  /**
   * Relays the same RFB stream the desktop VNC tab uses. The guest bridge
   * token stays on the main-process side; the phone only proves its own device
   * cookie. Nothing listens on a public interface except this authenticated
   * WebSocket route.
   */
  private attachDesktop(client: WebSocket): void {
    const state = this.deps.runtime.getState()
    if (state.phase !== 'running' || !state.vncUrl) {
      client.close(1011, 'Linux is not running')
      return
    }
    const target = new WebSocket(state.vncUrl, { perMessageDeflate: false })
    const pending: Buffer[] = []
    let closed = false
    const closeBoth = (code = 1000, reason = ''): void => {
      if (closed) return
      closed = true
      try {
        if (client.readyState === WebSocket.OPEN) client.close(code, reason)
      } catch {
        /* ignore */
      }
      try {
        target.close()
      } catch {
        /* ignore */
      }
    }
    target.on('open', () => {
      for (const chunk of pending.splice(0)) {
        if (target.readyState === WebSocket.OPEN) target.send(chunk, { binary: true })
      }
      logger.info('remote', 'a paired phone attached to the desktop')
    })
    target.on('message', (data, isBinary) => {
      if (!isBinary) return
      if (client.readyState !== WebSocket.OPEN) return
      if (client.bufferedAmount > 8 * 1024 * 1024) {
        closeBoth(1013, 'The phone is too slow to display the desktop')
        return
      }
      client.send(data, { binary: true })
    })
    target.on('error', (error) => {
      logger.warn('remote', 'desktop relay failed', error)
      closeBoth(1011, 'Desktop connection failed')
    })
    target.on('close', () => closeBoth(1000, 'Desktop closed'))
    client.on('message', (data, isBinary) => {
      if (!isBinary) return
      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer)
      if (target.readyState === WebSocket.OPEN) target.send(buffer, { binary: true })
      else if (target.readyState === WebSocket.CONNECTING) pending.push(buffer)
    })
    client.on('close', () => closeBoth())
    client.on('error', () => closeBoth())
  }

  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const now = Date.now()
    this.pairingAttempts = this.pairingAttempts.filter((at) => now - at < PAIRING_WINDOW_MS)
    if (this.pairingAttempts.length >= PAIRING_MAX_ATTEMPTS) {
      this.json(response, 429, { error: 'Too many pairing attempts. Wait five minutes and try again.' })
      return
    }
    this.pairingAttempts.push(now)
    const body = await this.readJson(request)
    const code = typeof body.code === 'string' ? body.code : ''
    const name = typeof body.name === 'string' ? body.name : 'Phone'
    const paired = this.deps.store.pair(code, name)
    if (!paired) {
      this.json(response, 401, { error: 'That pairing code is wrong or has expired.' })
      return
    }
    this.pairingAttempts = []
    const secure = this.isHttps(request)
    response.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${paired.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}${
        secure ? '; Secure' : ''
      }`
    )
    const native = request.headers['x-tagnest-native'] === '1'
    this.json(response, 200, {
      ok: true,
      device: paired.device,
      // Native clients cannot rely on a browser cookie jar; they store the
      // token in Android's private app storage and send it as a Bearer header.
      ...(native ? { token: paired.token } : {})
    })
    this.deps.onDevicesChanged?.()
    this.notify()
    logger.info('remote', 'a phone completed pairing')
  }

  private snapshot(deviceId: string): unknown {
    const state = this.deps.runtime.getState()
    const activeId = this.deps.conversations.getActiveId()
    const conversation: Conversation | null = activeId ? this.deps.conversations.get(activeId) ?? null : null
    return {
      version: this.deps.version,
      deviceId,
      runtime: publicRuntime(state),
      conversations: this.deps.conversations.list(),
      activeConversationId: activeId,
      conversation,
      task: this.deps.agent.getTask(),
      approval: this.deps.agent.getPendingApproval()
    }
  }

  private authenticate(request: IncomingMessage): { id: string } | null {
    const header = request.headers.authorization
    const bearer = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : undefined
    const cookies = parseCookies(request.headers.cookie)
    const device = this.deps.store.authenticate(bearer || cookies[COOKIE_NAME])
    return device ? { id: device.id } : null
  }

  private isHttps(request: IncomingMessage): boolean {
    return (request.headers['x-forwarded-proto'] ?? '').toString().split(',')[0].trim() === 'https'
  }

  private allowedOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin
    if (!origin) return true // native apps and same-origin navigations
    try {
      return new URL(origin).host === request.headers.host
    } catch {
      return false
    }
  }

  private securityHeaders(response: ServerResponse): void {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    response.setHeader('Cache-Control', 'no-store')
  }

  private serveNoVnc(relative: string, response: ServerResponse): void {
    let decoded: string
    try {
      decoded = decodeURIComponent(relative)
    } catch {
      this.json(response, 400, { error: 'Bad path' })
      return
    }
    const root = resolve(this.deps.novncDir)
    const target = resolve(root, normalize(decoded))
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      this.json(response, 403, { error: 'Forbidden' })
      return
    }
    let stats
    try {
      stats = statSync(target)
    } catch {
      this.json(response, 404, { error: 'Not found' })
      return
    }
    if (!stats.isFile()) {
      this.json(response, 404, { error: 'Not found' })
      return
    }
    const types: Record<string, string> = {
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
      '.json': 'application/json; charset=utf-8'
    }
    response.writeHead(200, {
      'Content-Type': types[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stats.size,
      'Cache-Control': 'public, max-age=3600'
    })
    createReadStream(target).pipe(response)
  }

  private send(response: ServerResponse, status: number, type: string, body: string): void {
    response.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) })
    response.end(body)
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    if (response.writableEnded) return
    const body = JSON.stringify(value)
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    })
    response.end(body)
  }

  private async readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) throw new Error('Request body too large')
      chunks.push(buffer)
    }
    if (chunks.length === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }

  private notify(): void {
    if (!this.wss || this.eventClients.size === 0 || this.broadcastTimer) return
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null
      const payload = JSON.stringify({ type: 'refresh', at: Date.now() })
      for (const client of this.eventClients) {
        if (client.readyState === WebSocket.OPEN) client.send(payload)
      }
    }, 150)
  }
}

/** VNC URL, SSH port and local log paths never leave the desktop app. */
export function publicRuntime(state: RuntimeState): Omit<RuntimeState, 'vncUrl' | 'sshPort' | 'logPath'> {
  const { vncUrl: _vncUrl, sshPort: _sshPort, logPath: _logPath, ...safe } = state
  return safe
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {}
  if (!header) return result
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index <= 0) continue
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!name) continue
    try {
      result[name] = decodeURIComponent(value)
    } catch {
      result[name] = value
    }
  }
  return result
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
