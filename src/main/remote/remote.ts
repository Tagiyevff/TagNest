import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { RemoteAccessState, RemoteMode } from '../../shared/types'
import type { AgentRuntime } from '../agent/agent'
import type { LinuxRuntime } from '../linux/runtime'
import type { ConversationStore } from '../storage/conversations'
import { logger } from '../logger'
import { RemoteServer } from './server'
import { RemoteStore } from './store'
import { QuickTunnel, ensureCloudflared } from './tunnel'

export interface RemoteAccessDeps {
  userDataDir: string
  runtime: LinuxRuntime
  agent: AgentRuntime
  conversations: ConversationStore
  version: string
  novncDir: string
}

type Listener = (state: RemoteAccessState) => void

/**
 * Owns the phone-access lifecycle: local server, optional public quick tunnel,
 * device list and pairing code. All of it stays in the main process.
 */
export class RemoteAccess {
  private readonly store: RemoteStore
  private readonly toolsDir: string
  private server: RemoteServer | null = null
  private tunnel: QuickTunnel | null = null
  private startAbort: AbortController | null = null
  private startToken = 0
  private readonly listeners = new Set<Listener>()
  private state: RemoteAccessState

  constructor(private readonly deps: RemoteAccessDeps) {
    this.store = new RemoteStore(deps.userDataDir)
    this.toolsDir = join(deps.userDataDir, 'tools')
    const saved = this.store.get()
    this.state = {
      enabled: saved.enabled,
      phase: 'stopped',
      mode: saved.mode,
      message: saved.enabled ? 'Remote access will start shortly.' : 'Remote access is off',
      ...(saved.customUrl ? { customUrl: saved.customUrl } : {}),
      devices: this.store.devices()
    }
  }

  onState(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): RemoteAccessState {
    return {
      ...this.state,
      devices: this.state.devices.map((device) => ({ ...device }))
    }
  }

  /** Restarts the server if the user left remote access enabled. */
  async restore(): Promise<void> {
    const saved = this.store.get()
    if (!saved.enabled) return
    await this.enable(saved.mode, saved.customUrl, { restored: true })
  }

  async enable(mode: RemoteMode, customUrl = '', options: { restored?: boolean } = {}): Promise<RemoteAccessState> {
    if (this.state.phase === 'starting') return this.getState()
    await this.stopInternal()
    const token = ++this.startToken
    const controller = new AbortController()
    this.startAbort = controller
    const normalizedUrl = mode === 'custom' ? normalizeCustomUrl(customUrl) : ''
    this.store.update({ enabled: true, mode, customUrl: normalizedUrl })
    const pairing = this.store.ensurePairingCode()
    this.setState({
      enabled: true,
      phase: 'starting',
      mode,
      message: options.restored ? 'Restoring remote access…' : 'Preparing remote access…',
      ...(normalizedUrl ? { customUrl: normalizedUrl } : {}),
      pairingCode: pairing.code,
      pairingExpiresAt: pairing.expiresAt,
      devices: this.store.devices(),
      error: undefined,
      url: undefined
    })

    if (mode === 'custom' && !normalizedUrl) {
      this.fail('Enter the https URL of your own tunnel (for example an HTTPS address from a home server or Tailscale), then try again.')
      return this.getState()
    }

    try {
      const server = new RemoteServer({
        store: this.store,
        runtime: this.deps.runtime,
        agent: this.deps.agent,
        conversations: this.deps.conversations,
        version: this.deps.version,
        novncDir: this.deps.novncDir,
        onDevicesChanged: () => this.syncDevices()
      })
      const host = mode === 'lan' ? '0.0.0.0' : '127.0.0.1'
      const savedPort = this.store.get().port
      const handle = await server.start(savedPort, host)
      if (token !== this.startToken) {
        await handle.close()
        return this.getState()
      }
      this.server = server
      this.store.update({ port: handle.port })
      const localUrl = `http://127.0.0.1:${handle.port}`
      let lanUrl: string | undefined
      let url: string | undefined
      let message = ''

      if (mode === 'lan') {
        const address = findLanAddress()
        lanUrl = address ? `http://${address}:${handle.port}` : undefined
        url = lanUrl ?? localUrl
        message = lanUrl
          ? `Ready on your home network: ${lanUrl}`
          : 'The server is ready, but no private LAN address was found. Connect this computer to Wi-Fi or Ethernet, or use the public tunnel.'
        if (!lanUrl) {
          this.setState({ message, lanUrl: undefined, localUrl })
        }
      } else if (mode === 'custom') {
        url = normalizedUrl
        message = `Ready through your own URL: ${normalizedUrl}`
      } else {
        this.setState({
          message: 'Preparing the public tunnel…',
          localUrl,
          phase: 'starting'
        })
        const binary = await ensureCloudflared(
          this.toolsDir,
          (percent) => {
            if (token !== this.startToken) return
            this.setState({
              message:
                percent < 100
                  ? `Downloading the public tunnel helper (${percent}%)…`
                  : 'Starting the public tunnel…',
              tunnelProgress: percent,
              phase: 'starting'
            })
          },
          controller.signal
        )
        if (token !== this.startToken) {
          await server.stop()
          return this.getState()
        }
        const tunnel = new QuickTunnel()
        this.tunnel = tunnel
        this.setState({ message: 'Starting the public tunnel…', phase: 'starting' })
        const publicUrl = await tunnel.start(binary, handle.port, {
          onLog: (line) => logger.debug('remote', 'cloudflared', line),
          onExit: (reason) => {
            if (token !== this.startToken) return
            this.tunnel = null
            this.setState({
              phase: 'error',
              enabled: true,
              message: 'The public tunnel closed',
              error: reason,
              url: undefined
            })
          }
        })
        if (token !== this.startToken) {
          await tunnel.stop()
          await server.stop()
          return this.getState()
        }
        this.setState({ message: 'Waiting for the public address to become reachable…', phase: 'starting' })
        const reachable = await waitForPublicUrl(publicUrl)
        if (token !== this.startToken) {
          await tunnel.stop()
          await server.stop()
          return this.getState()
        }
        url = publicUrl
        message = reachable
          ? `Ready from anywhere: ${publicUrl}`
          : `Public address created: ${publicUrl} (if the phone cannot open it yet, wait a minute and try again)`
      }

      const latestCode = this.store.ensurePairingCode()
      this.setState({
        enabled: true,
        phase: 'running',
        mode,
        message,
        ...(url ? { url } : {}),
        localUrl,
        ...(lanUrl ? { lanUrl } : {}),
        ...(mode === 'custom' ? { customUrl: normalizedUrl } : {}),
        port: handle.port,
        pairingCode: latestCode.code,
        pairingExpiresAt: latestCode.expiresAt,
        devices: this.store.devices(),
        error: undefined,
        tunnelProgress: mode === 'tunnel' ? 100 : undefined
      })
      logger.info('remote', `phone access ready (${mode})`)
    } catch (error) {
      if (token !== this.startToken) return this.getState()
      const message = error instanceof Error ? error.message : String(error)
      this.fail(message)
    }
    return this.getState()
  }

  async disable(): Promise<RemoteAccessState> {
    this.startToken += 1
    this.startAbort?.abort()
    this.startAbort = null
    this.store.update({ enabled: false })
    await this.stopInternal()
    this.setState({
      enabled: false,
      phase: 'stopped',
      message: 'Remote access is off',
      url: undefined,
      localUrl: undefined,
      lanUrl: undefined,
      port: undefined,
      pairingCode: undefined,
      pairingExpiresAt: undefined,
      error: undefined,
      devices: this.store.devices()
    })
    logger.info('remote', 'phone access stopped')
    return this.getState()
  }

  regenerateCode(): RemoteAccessState {
    const pairing = this.store.issuePairingCode()
    this.setState({
      pairingCode: pairing.code,
      pairingExpiresAt: pairing.expiresAt,
      error: this.state.error
    })
    return this.getState()
  }

  revokeDevice(id: string): RemoteAccessState {
    this.store.revoke(id)
    this.syncDevices()
    return this.getState()
  }

  /** Pairing consumes the code and revoking removes a device; mirror both. */
  private syncDevices(): void {
    const saved = this.store.get()
    this.setState({
      devices: this.store.devices(),
      pairingCode: saved.pairingCode,
      pairingExpiresAt: saved.pairingExpiresAt
    })
  }

  async dispose(): Promise<void> {
    this.startToken += 1
    this.startAbort?.abort()
    await this.stopInternal()
  }

  private fail(message: string): void {
    const server = this.server
    const tunnel = this.tunnel
    this.server = null
    this.tunnel = null
    void tunnel?.stop()
    void server?.stop()
    this.setState({
      enabled: true,
      phase: 'error',
      message: 'Remote access could not start',
      error: message,
      url: undefined
    })
    logger.warn('remote', `phone access failed: ${message}`)
  }

  private async stopInternal(): Promise<void> {
    const tunnel = this.tunnel
    const server = this.server
    this.tunnel = null
    this.server = null
    await tunnel?.stop().catch(() => undefined)
    await server?.stop().catch(() => undefined)
  }

  private setState(patch: Partial<RemoteAccessState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      try {
        listener(this.getState())
      } catch (error) {
        logger.warn('remote', 'a state listener failed', error)
      }
    }
  }
}

export function normalizeCustomUrl(input: string): string {
  const value = input.trim()
  if (!value) return ''
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return ''
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return ''
  if (parsed.username || parsed.password) return ''
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return ''
  return parsed.origin
}

/** Picks the most plausible private IPv4 address for Home network mode. */
/** Confirms the public URL actually reaches this server before reporting ready. */
export async function waitForPublicUrl(url: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6000) })
      if (response.ok) return true
    } catch {
      // DNS or the edge can take a few seconds after the tunnel registers.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  return false
}

export function findLanAddress(): string | undefined {
  const candidates: string[] = []
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      candidates.push(entry.address)
    }
  }
  const score = (address: string): number => {
    if (address.startsWith('192.168.')) return 3
    if (address.startsWith('10.')) return 2
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 1
    return 0
  }
  return candidates.sort((a, b) => score(b) - score(a))[0]
}
