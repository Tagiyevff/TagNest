import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import type { RemoteDevice, RemoteMode } from '../../shared/types'
import { readJsonFile, writeJsonFileAtomic } from '../storage/json'
import { logger } from '../logger'

const PAIRING_TTL_MS = 15 * 60 * 1000
const LAST_SEEN_WRITE_MS = 60 * 1000

export interface StoredRemoteDevice extends RemoteDevice {
  /** SHA-256 of the bearer token. The token itself is never written to disk. */
  tokenHash: string
}

export interface RemoteSettings {
  enabled: boolean
  mode: RemoteMode
  customUrl: string
  port: number
  pairingCode?: string
  pairingExpiresAt?: number
  devices: StoredRemoteDevice[]
}

const DEFAULTS: RemoteSettings = {
  enabled: false,
  mode: 'tunnel',
  customUrl: '',
  port: 47821,
  devices: []
}

function isMode(value: unknown): value is RemoteMode {
  return value === 'tunnel' || value === 'lan' || value === 'custom'
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function normalizeDevice(value: unknown): StoredRemoteDevice | null {
  if (!value || typeof value !== 'object') return null
  const entry = value as Partial<StoredRemoteDevice>
  if (typeof entry.id !== 'string' || !entry.id) return null
  if (typeof entry.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.tokenHash)) return null
  return {
    id: entry.id,
    name: typeof entry.name === 'string' ? entry.name.slice(0, 60) : 'Phone',
    tokenHash: entry.tokenHash,
    createdAt: typeof entry.createdAt === 'number' ? entry.createdAt : Date.now(),
    ...(typeof entry.lastSeenAt === 'number' ? { lastSeenAt: entry.lastSeenAt } : {})
  }
}

/**
 * Small durable store for the phone-access server: the chosen mode, the bound
 * port, the printable pairing code and one hashed token per paired device.
 * It never contains an API key or a guest credential.
 */
export class RemoteStore {
  private readonly file: string
  private data: RemoteSettings

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'remote.json')
    const raw = readJsonFile<Partial<RemoteSettings>>(this.file, {})
    const devices = Array.isArray(raw.devices)
      ? raw.devices.map(normalizeDevice).filter((entry): entry is StoredRemoteDevice => Boolean(entry))
      : []
    this.data = {
      enabled: raw.enabled === true,
      mode: isMode(raw.mode) ? raw.mode : DEFAULTS.mode,
      customUrl: typeof raw.customUrl === 'string' ? raw.customUrl.slice(0, 500) : '',
      port:
        typeof raw.port === 'number' && raw.port >= 1024 && raw.port <= 65535 ? raw.port : DEFAULTS.port,
      ...(typeof raw.pairingCode === 'string' && /^\d{6}$/.test(raw.pairingCode)
        ? { pairingCode: raw.pairingCode }
        : {}),
      ...(typeof raw.pairingExpiresAt === 'number' ? { pairingExpiresAt: raw.pairingExpiresAt } : {}),
      devices
    }
  }

  get(): RemoteSettings {
    return {
      ...this.data,
      devices: this.data.devices.map((device) => ({ ...device }))
    }
  }

  update(patch: Partial<Pick<RemoteSettings, 'enabled' | 'mode' | 'customUrl' | 'port'>>): void {
    if (typeof patch.enabled === 'boolean') this.data.enabled = patch.enabled
    if (isMode(patch.mode)) this.data.mode = patch.mode
    if (typeof patch.customUrl === 'string') this.data.customUrl = patch.customUrl.slice(0, 500)
    if (typeof patch.port === 'number' && patch.port >= 1024 && patch.port <= 65535) {
      this.data.port = patch.port
    }
    this.save()
  }

  /** A code is valid for 15 minutes and can be used once. */
  ensurePairingCode(now = Date.now()): { code: string; expiresAt: number } {
    if (this.data.pairingCode && (this.data.pairingExpiresAt ?? 0) > now + 30_000) {
      return { code: this.data.pairingCode, expiresAt: this.data.pairingExpiresAt as number }
    }
    return this.issuePairingCode(now)
  }

  issuePairingCode(now = Date.now()): { code: string; expiresAt: number } {
    // randomInt is cryptographically secure; pad so the UI always shows 6 digits.
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const expiresAt = now + PAIRING_TTL_MS
    this.data.pairingCode = code
    this.data.pairingExpiresAt = expiresAt
    this.save()
    logger.info('remote', 'a new pairing code was generated')
    return { code, expiresAt }
  }

  /** Verifies the code and creates a device token. Returns null on failure. */
  pair(code: string, name: string, now = Date.now()): { device: RemoteDevice; token: string } | null {
    const expected = this.data.pairingCode
    const expiresAt = this.data.pairingExpiresAt ?? 0
    if (!expected || expiresAt <= now) return null
    const supplied = code.replace(/\s+/g, '')
    if (!/^\d{6}$/.test(supplied)) return null
    const expectedBytes = Buffer.from(expected)
    const suppliedBytes = Buffer.from(supplied)
    if (expectedBytes.length !== suppliedBytes.length) return null
    if (!timingSafeEqual(expectedBytes, suppliedBytes)) return null

    const token = randomBytes(32).toString('base64url')
    const device: StoredRemoteDevice = {
      id: randomUUID(),
      name: name.trim().slice(0, 60) || 'Phone',
      tokenHash: hashToken(token),
      createdAt: now
    }
    this.data.devices.push(device)
    this.data.pairingCode = undefined
    this.data.pairingExpiresAt = undefined
    this.save()
    logger.info('remote', `a phone paired (${device.name})`)
    return {
      device: publicDevice(device),
      token
    }
  }

  /** Finds a device by its bearer token using a constant-time hash comparison. */
  authenticate(token: string | undefined): RemoteDevice | null {
    if (!token || token.length < 20 || token.length > 200) return null
    const supplied = Buffer.from(hashToken(token), 'hex')
    for (const device of this.data.devices) {
      const expected = Buffer.from(device.tokenHash, 'hex')
      if (expected.length !== supplied.length) continue
      if (timingSafeEqual(expected, supplied)) return publicDevice(device)
    }
    return null
  }

  touch(id: string, now = Date.now()): void {
    const device = this.data.devices.find((entry) => entry.id === id)
    if (!device) return
    if (device.lastSeenAt && now - device.lastSeenAt < LAST_SEEN_WRITE_MS) return
    device.lastSeenAt = now
    this.save()
  }

  revoke(id: string): boolean {
    const before = this.data.devices.length
    this.data.devices = this.data.devices.filter((device) => device.id !== id)
    if (this.data.devices.length === before) return false
    this.save()
    logger.info('remote', 'a paired device was revoked')
    return true
  }

  revokeAll(): void {
    if (this.data.devices.length === 0) return
    this.data.devices = []
    this.save()
  }

  devices(): RemoteDevice[] {
    return this.data.devices.map(publicDevice)
  }

  private save(): void {
    writeJsonFileAtomic(this.file, this.data)
  }
}

function publicDevice(device: StoredRemoteDevice): RemoteDevice {
  return {
    id: device.id,
    name: device.name,
    createdAt: device.createdAt,
    ...(device.lastSeenAt ? { lastSeenAt: device.lastSeenAt } : {})
  }
}
