import { randomBytes } from 'node:crypto'
import { createServer as createNetServer, connect, type Socket } from 'node:net'
import { WebSocketServer, type WebSocket } from 'ws'
import { logger } from '../logger'

export interface VncBridgeHandle {
  /** Authenticated loopback WebSocket URL for noVNC. */
  url: string
  close: () => Promise<void>
}

/**
 * Bridges the renderer's noVNC WebSocket to the guest's raw RFB TCP port
 * (exposed by QEMU on loopback). A per-session random token prevents other
 * local processes from attaching to the display.
 */
export class VncBridge {
  private wss: WebSocketServer | null = null
  private sockets = new Set<Socket>()
  private token = ''
  private target: { port: number; host: string } | null = null

  async start(targetPort: number, host = '127.0.0.1'): Promise<VncBridgeHandle> {
    await this.close()
    this.target = { port: targetPort, host }
    this.token = randomBytes(24).toString('hex')

    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 32 * 1024 * 1024 })
    this.wss = server

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.once('listening', () => resolve())
    })

    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Could not start the desktop bridge.')
    const url = `ws://127.0.0.1:${address.port}/?token=${this.token}`

    server.on('connection', (socket: WebSocket, request) => {
      const requestUrl = new URL(request.url ?? '/', 'http://localhost')
      if (requestUrl.searchParams.get('token') !== this.token) {
        socket.close(4401, 'Unauthorized')
        return
      }
      if (!this.target) {
        socket.close(4404, 'Desktop unavailable')
        return
      }
      const tcp = connect(this.target.port, this.target.host)
      this.sockets.add(tcp)

      const closeBoth = (): void => {
        this.sockets.delete(tcp)
        tcp.destroy()
        if (socket.readyState === socket.OPEN) socket.close()
      }

      tcp.on('connect', () => {
        logger.debug('vnc', 'renderer attached to guest display')
      })
      tcp.on('data', (data) => {
        if (socket.readyState === socket.OPEN) socket.send(data, { binary: true })
      })
      socket.on('message', (data, isBinary) => {
        if (!isBinary) return
        tcp.write(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer))
      })
      tcp.on('error', closeBoth)
      tcp.on('close', closeBoth)
      socket.on('close', closeBoth)
      socket.on('error', closeBoth)
    })

    logger.info('vnc', `desktop bridge listening for VNC at ${address.port}`)
    return {
      url,
      close: () => this.close()
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    const server = this.wss
    this.wss = null
    this.target = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      setTimeout(resolve, 500)
    })
  }
}

export async function getFreeLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('No free loopback port'))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export async function waitForTcpPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1')
      const done = (result: boolean): void => {
        socket.destroy()
        resolve(result)
      }
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
      socket.setTimeout(1000, () => done(false))
    })
    if (ok) return true
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}
