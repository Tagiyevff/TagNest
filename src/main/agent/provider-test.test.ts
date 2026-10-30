import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings } from '../../shared/types'
import type { SecretsStore } from '../storage/secrets'
import type { SettingsStore } from '../storage/settings'
import { testProviderConnection } from './provider-test'

const SETTINGS: AppSettings = {
  provider: 'openai',
  model: 'gpt-test',
  modelMode: 'manual',
  baseUrl: '',
  language: 'en',
  memoryMB: 3072,
  cpus: 2,
  diskGB: 20,
  autoStartLinux: true,
  approveSafeCommands: true,
  launchAtLogin: false
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

  it('resolves an explicit free OpenRouter model before testing', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'qwen/qwen3:free',
                  name: 'Qwen3 Free',
                  context_length: 131072,
                  pricing: { prompt: '0', completion: '0' },
                  supported_parameters: ['tools'],
                  architecture: { output_modalities: ['text'] }
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    const { settings, secrets } = stores({
      apiKey: 'sk-or-test',
      settings: {
        provider: 'openrouter',
        model: 'openai/gpt-4.1-mini',
        modelMode: 'free-auto'
      }
    })
    const result = await testProviderConnection(settings, secrets)
    expect(result.ok).toBe(true)
    expect(result.model).toBe('qwen/qwen3:free')
    expect(calls[0]).toContain('/models')
    expect(calls[1]).toContain('/chat/completions')
  })

  it('falls back to the next free model when one refuses direct API traffic', async () => {
    const attempted: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/models')) {
          return new Response(
            JSON.stringify({
              data: [
                {
                  id: 'blocked/model:free',
                  name: 'Blocked',
                  context_length: 200000,
                  pricing: { prompt: '0', completion: '0' },
                  supported_parameters: ['tools'],
                  architecture: { output_modalities: ['text'] }
                },
                {
                  id: 'works/model:free',
                  name: 'Works',
                  context_length: 32000,
                  pricing: { prompt: '0', completion: '0' },
                  supported_parameters: ['tools'],
                  architecture: { output_modalities: ['text'] }
                }
              ]
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          )
        }
        const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string }
        attempted.push(body.model ?? '')
        if (body.model === 'blocked/model:free') {
          return new Response(
            JSON.stringify({ error: { message: 'only available on agentic harnesses' } }),
            { status: 403, headers: { 'content-type': 'application/json' } }
          )
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      })
    )
    const { settings, secrets } = stores({
      apiKey: 'sk-or-test',
      settings: {
        provider: 'openrouter',
        model: 'old',
        modelMode: 'free-auto'
      }
    })
    const result = await testProviderConnection(settings, secrets)
    expect(result.ok).toBe(true)
    expect(result.model).toBe('works/model:free')
    expect(attempted).toEqual(['blocked/model:free', 'works/model:free'])
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
