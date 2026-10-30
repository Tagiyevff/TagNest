import { join } from 'node:path'
import { DEFAULT_SETTINGS } from '../../shared/ipc'
import { PROVIDERS, type AppSettings, type ProviderId, type SettingsView } from '../../shared/types'
import { readJsonFile, writeJsonFileAtomic } from './json'
import type { SecretsStore } from './secrets'
import { logger } from '../logger'

const PROVIDER_IDS = new Set(PROVIDERS.map((p) => p.id))

function providerInfo(id: ProviderId) {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]
}

/**
 * Settings live in a small JSON file. Secrets are kept separately in the OS
 * credential store (see SecretsStore) and are never part of this payload.
 */
export class SettingsStore {
  private readonly file: string
  private settings: AppSettings

  constructor(
    userDataDir: string,
    private readonly secrets: SecretsStore
  ) {
    this.file = join(userDataDir, 'settings.json')
    this.settings = this.sanitize(readJsonFile<Partial<AppSettings>>(this.file, {}))
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  getView(): SettingsView {
    return {
      ...this.settings,
      hasApiKey: this.secrets.has(this.settings.provider),
      providers: PROVIDERS
    }
  }

  update(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = { ...this.settings }

    if (patch.language) next.language = patch.language
    if (typeof patch.autoStartLinux === 'boolean') next.autoStartLinux = patch.autoStartLinux
    if (typeof patch.approveSafeCommands === 'boolean') next.approveSafeCommands = patch.approveSafeCommands
    if (typeof patch.launchAtLogin === 'boolean') next.launchAtLogin = patch.launchAtLogin

    if (typeof patch.memoryMB === 'number') next.memoryMB = clamp(patch.memoryMB, 1024, 16384)
    if (typeof patch.cpus === 'number') next.cpus = clamp(patch.cpus, 1, 8)
    if (typeof patch.diskGB === 'number') next.diskGB = clamp(patch.diskGB, 8, 128)

    if (patch.provider && patch.provider !== next.provider) {
      next.provider = patch.provider
      const info = providerInfo(patch.provider)
      next.model = patch.model ?? info.defaultModel
      next.modelMode =
        patch.provider === 'openrouter' && patch.modelMode === 'free-auto' ? 'free-auto' : 'manual'
      // Honour an endpoint supplied together with the provider switch; only
      // fall back to the provider's default when none was sent.
      next.baseUrl = info.supportsBaseUrl
        ? typeof patch.baseUrl === 'string' && patch.baseUrl.trim()
          ? patch.baseUrl.trim()
          : info.defaultBaseUrl
        : ''
    } else {
      if (patch.provider) next.provider = patch.provider
      if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim()
      if (patch.modelMode) next.modelMode = patch.modelMode
      if (typeof patch.baseUrl === 'string') next.baseUrl = patch.baseUrl.trim()
    }

    this.settings = this.sanitize(next)
    writeJsonFileAtomic(this.file, this.settings)
    logger.info('settings', 'settings updated')
    return this.get()
  }

  /** Resolved endpoint for the active provider. */
  resolveBaseUrl(): string {
    const info = providerInfo(this.settings.provider)
    if (info.supportsBaseUrl) return (this.settings.baseUrl || info.defaultBaseUrl).replace(/\/+$/, '')
    return info.defaultBaseUrl.replace(/\/+$/, '')
  }

  firstRun(): boolean {
    return !readJsonFile<Record<string, unknown>>(this.file, {}) ||
      Object.keys(readJsonFile<Record<string, unknown>>(this.file, {})).length === 0
  }

  private sanitize(raw: Partial<AppSettings>): AppSettings {
    const provider = raw.provider && PROVIDER_IDS.has(raw.provider) ? raw.provider : DEFAULT_SETTINGS.provider
    const info = providerInfo(provider)
    const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : info.defaultModel
    const baseUrl = info.supportsBaseUrl
      ? typeof raw.baseUrl === 'string' && raw.baseUrl.trim()
        ? raw.baseUrl.trim()
        : info.defaultBaseUrl
      : ''
    return {
      provider,
      model,
      modelMode: provider === 'openrouter' && raw.modelMode === 'free-auto' ? 'free-auto' : 'manual',
      baseUrl,
      language: raw.language === 'az' ? 'az' : 'en',
      memoryMB: clamp(Number(raw.memoryMB) || DEFAULT_SETTINGS.memoryMB, 1024, 16384),
      cpus: clamp(Number(raw.cpus) || DEFAULT_SETTINGS.cpus, 1, 8),
      diskGB: clamp(Number(raw.diskGB) || DEFAULT_SETTINGS.diskGB, 8, 128),
      autoStartLinux: raw.autoStartLinux ?? DEFAULT_SETTINGS.autoStartLinux,
      approveSafeCommands: raw.approveSafeCommands ?? DEFAULT_SETTINGS.approveSafeCommands,
      launchAtLogin: raw.launchAtLogin ?? DEFAULT_SETTINGS.launchAtLogin
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)))
}
