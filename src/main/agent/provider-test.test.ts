import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import type { SecretsStore } from '../storage/secrets'
import type { SettingsStore } from '../storage/settings'
import { testProviderConnection } from './provider-test'

const SETTINGS: AppSettings = {
  provider: 'openai',
  model: 'gpt-test',
  baseUrl: '',
  language: 'en',
  memoryMB: 3072,
  cpus: 2,
  diskGB: 20,
  autoStartLinux: true,
  approveSafeCommands: true
}

function stores(options: { apiKey?: string; settings?: Partial<AppSettings> } = {}): {
  settings: SettingsStore
  secrets: SecretsStore
} {
  const current = { ...SETTINGS, ...options.settings }
  return {
    settings: {
      get: () => ({ ...current }),
      resolveBaseUrl: () => 'https://api.openai.com/v1'
    } as unknown as SettingsStore,
    secrets: {
      get: () => options.apiKey
    } as unknown as SecretsStore
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('testProviderConnection', () => {
  it('reports a real successful reply and latency', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    const { settings, secrets } = stores({ apiKey: 'sk-test' })
    const result = await testProviderConnection(settings, secrets)
    expect(result.ok).toBe(true)
    expect(result.reply).toBe('OK')
    expect(result.model).toBe('gpt-test')
    expect(result.latencyMs).toBeGreaterThanOrEqual(0)
    expect(result.message).toContain('Connected')
  })

  it('refuses to test a provider that requires a missing key', async () => {
    const { settings, secrets } = stores()
    const result = await testProviderConnection(settings, secrets)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('No OpenAI API key')
  })

  it('surfaces the provider rejection instead of a fake success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' }
        })
      )
    )
    const { settings, secrets } = stores({ apiKey: 'sk-bad' })
    const result = await testProviderConnection(settings, secrets)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('401')
    expect(result.message).toContain('Incorrect API key')
  })

  it('reports a local endpoint that is not running', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed')
      })
    )
    const { settings, secrets } = stores({
      apiKey: 'unused',
      settings: { provider: 'custom', model: 'local-model', baseUrl: 'http://127.0.0.1:9/v1' }
    })
    const result = await testProviderConnection(settings, secrets)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('fetch failed')
  })
})
