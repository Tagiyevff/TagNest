import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelOption } from '../../../shared/types'
import {
  fetchProviderModels,
  isChatModelId,
  parseAnthropicModels,
  parseGeminiModels,
  parseOllamaModels,
  parseOpenAiModels,
  parseOpenRouterModels,
  rankFreeModels
} from './models'

afterEach(() => {
  vi.unstubAllGlobals()
})

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

describe('parseOpenAiModels', () => {
  it('keeps chat models and drops embeddings and audio tools', () => {
    const models = parseOpenAiModels(
      {
        data: [
          { id: 'gpt-4.1-mini', owned_by: 'openai' },
          { id: 'text-embedding-3-large', owned_by: 'openai' },
          { id: 'gpt-4o-audio-preview', owned_by: 'openai' },
          { id: 'o3', owned_by: 'openai' }
        ]
      },
      true
    )
    expect(models.map((model) => model.id)).toEqual(['gpt-4.1-mini', 'o3'])
    expect(isChatModelId('text-embedding-3-large')).toBe(false)
  })

  it('does not filter custom OpenAI-compatible servers', () => {
    const models = parseOpenAiModels({ data: [{ id: 'my-embedding-model' }] }, false)
    expect(models).toHaveLength(1)
  })
})

describe('parseOpenRouterModels', () => {
  it('marks explicitly free models and reads capabilities', () => {
    const models = parseOpenRouterModels({
      data: [
        {
          id: 'qwen/qwen3:free',
          name: 'Qwen3 Free',
          context_length: 131072,
          pricing: { prompt: '0', completion: '0' },
          architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
          supported_parameters: ['tools', 'temperature']
        },
        {
          id: 'paid/model',
          name: 'Paid',
          context_length: 8000,
          pricing: { prompt: '0.000001', completion: '0.000002' },
          architecture: { input_modalities: ['text'], output_modalities: ['text'] }
        },
        {
          id: 'hidden/image-only',
          name: 'Image only',
          architecture: { output_modalities: ['image'] }
        }
      ]
    })
    expect(models.map((model) => model.id)).toEqual(['qwen/qwen3:free', 'paid/model'])
    expect(models[0].free).toBe(true)
    expect(models[0].capabilities).toEqual(['chat', 'tools', 'vision'])
    expect(models[1].free).toBeUndefined()
  })
})

describe('other provider parsers', () => {
  it('parses Anthropic display names', () => {
    expect(
      parseAnthropicModels({
        data: [{ id: 'claude-test', display_name: 'Claude Test', created_at: '2025-01-01' }]
      })
    ).toMatchObject([{ id: 'claude-test', name: 'Claude Test', capabilities: ['chat'] }])
  })

  it('strips the Gemini models/ prefix and drops embedding-only entries', () => {
    const models = parseGeminiModels({
      models: [
        {
          name: 'models/gemini-2.5-flash',
          displayName: 'Gemini 2.5 Flash',
          inputTokenLimit: 1000000,
          outputTokenLimit: 65536,
          supportedGenerationMethods: ['generateContent']
        },
        {
          name: 'models/text-embedding-004',
          supportedGenerationMethods: ['embedContent']
        }
      ]
    })
    expect(models).toMatchObject([
      {
        id: 'gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        inputTokenLimit: 1000000,
        outputTokenLimit: 65536
      }
    ])
  })

  it('lists local Ollama models without embedding-only tags', () => {
    const models = parseOllamaModels({
      models: [
        { name: 'qwen2.5-coder:7b', details: { family: 'qwen2', parameter_size: '7B' } },
        { name: 'nomic-embed-text:latest', details: { family: 'nomic-bert' } }
      ]
    })
    expect(models).toMatchObject([
      { id: 'qwen2.5-coder:7b', name: 'qwen2.5-coder:7b', description: 'qwen2 · 7B' }
    ])
  })
})

describe('rankFreeModels', () => {
  it('prefers tool-capable free models with the largest context', () => {
    const models: ModelOption[] = [
      { id: 'free-no-tools', name: 'No tools', free: true, contextLength: 200000, capabilities: ['chat'] },
      { id: 'free-small', name: 'Small', free: true, contextLength: 16000, capabilities: ['chat', 'tools'] },
      { id: 'free-large', name: 'Large', free: true, contextLength: 131072, capabilities: ['chat', 'tools'] },
      { id: 'paid', name: 'Paid', contextLength: 1000000, capabilities: ['chat', 'tools'] }
    ]
    expect(rankFreeModels(models).map((model) => model.id)).toEqual(['free-large', 'free-small'])
  })

  it('falls back to any free model when tool support is not reported', () => {
    const models: ModelOption[] = [
      { id: 'free-a', name: 'A', free: true, contextLength: 8000 },
      { id: 'paid', name: 'Paid' }
    ]
    expect(rankFreeModels(models).map((model) => model.id)).toEqual(['free-a'])
  })
})

describe('fetchProviderModels', () => {
  it('uses the real OpenAI-compatible endpoint and auth header', async () => {
    const mock = vi.fn(async () => json({ data: [{ id: 'gpt-4.1-mini' }] }))
    vi.stubGlobal('fetch', mock)
    const catalog = await fetchProviderModels({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-test'
    })
    expect(mock).toHaveBeenCalledTimes(1)
    const [url, init] = mock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/models')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(catalog.provider).toBe('openai')
    expect(catalog.models[0].id).toBe('gpt-4.1-mini')
  })

  it('refuses to list OpenAI models without a key', async () => {
    await expect(
      fetchProviderModels({ provider: 'openai', baseUrl: 'https://api.openai.com/v1' })
    ).rejects.toThrow('No OpenAI API key')
  })

  it('surfaces a real API rejection with the model-list status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({ error: { message: 'Invalid API key' } }, 401))
    )
    await expect(
      fetchProviderModels({
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-wrong'
      })
    ).rejects.toMatchObject({ status: 401 })
  })

  it('uses the Ollama tags endpoint', async () => {
    const mock = vi.fn(async () => json({ models: [{ name: 'qwen2.5-coder:7b' }] }))
    vi.stubGlobal('fetch', mock)
    const catalog = await fetchProviderModels({
      provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1'
    })
    const [url] = mock.mock.calls[0] as unknown as [string]
    expect(url).toBe('http://127.0.0.1:11434/api/tags')
    expect(catalog.models[0].id).toBe('qwen2.5-coder:7b')
  })
})
