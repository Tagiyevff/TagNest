import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import type { ProviderId } from '../../shared/types'
import { readJsonFile, writeJsonFileAtomic } from './json'
import { logger } from '../logger'

type EncryptedMap = Partial<Record<ProviderId, string>>

/**
 * API keys are encrypted with the operating system's credential protection
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux) through Electron's
 * safeStorage. No key is ever written to disk in plaintext or logged.
 */
export class SecretsStore {
  private readonly file: string
  private cache: EncryptedMap

  constructor(userDataDir: string) {
    this.file = join(userDataDir, 'secrets.json')
    this.cache = readJsonFile<EncryptedMap>(this.file, {})
  }

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  has(provider: ProviderId): boolean {
    return Boolean(this.cache[provider]) && this.isAvailable()
  }

  get(provider: ProviderId): string | undefined {
    const encrypted = this.cache[provider]
    if (!encrypted) return undefined
    if (!this.isAvailable()) {
      logger.warn('secrets', 'OS credential storage is unavailable; refusing to decrypt stored key')
      return undefined
    }
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch (error) {
      logger.error('secrets', 'failed to decrypt stored key', error)
      return undefined
    }
  }

  set(provider: ProviderId, apiKey: string): void {
    if (!this.isAvailable()) {
      throw new Error('The operating system credential store is not available on this machine.')
    }
    this.cache[provider] = safeStorage.encryptString(apiKey).toString('base64')
    writeJsonFileAtomic(this.file, this.cache)
    logger.info('secrets', `stored API key for ${provider}`)
  }

  clear(provider: ProviderId): void {
    delete this.cache[provider]
    if (existsSync(this.file)) writeJsonFileAtomic(this.file, this.cache)
  }
}
