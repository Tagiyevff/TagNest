import type { ModelCatalog, ModelOption, ProviderId } from '../../../shared/types'
import { PROVIDERS } from '../../../shared/types'
import { ProviderError, readErrorBody, readJsonBody } from './types'

const MODELS_TIMEOUT_MS = 20_000

export interface FetchModelsInput {
  provider: ProviderId
  baseUrl: string
  apiKey?: string
  signal?: AbortSignal
}

/**
 * Reads the real model list from the provider's own API. Nothing here is a
 * hardcoded catalogue: if the endpoint fails, the user gets the endpoint's
 * actual error and no invented models.
 */
export async function fetchProviderModels(input: FetchModelsInput): Promise<ModelCatalog> {
  const info = PROVIDERS.find((provider) => provider.id === input.provider)
  const label = info?.label ?? input.provider
  const baseUrl = input.baseUrl.replace(/\/+$/, '')
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)])
    : AbortSignal.timeout(MODELS_TIMEOUT_MS)
  const fetchedAt = Date.now()

  switch (input.provider) {
    case 'openai':
    case 'custom': {
      if (input.provider === 'openai' && !input.apiKey) {
        throw new ProviderError('No OpenAI API key is stored.', undefined, 'Save a key in Settings first.')
      }
      const data = await requestJson<OpenAiModelList>({
        url: `${baseUrl}/models`,
        label,
        signal,
        headers: authHeaders(input.apiKey)
      })
      const models = parseOpenAiModels(data, input.provider === 'openai')
      return catalog(input.provider, models, fetchedAt, `${baseUrl}/models`)
    }
    case 'openrouter': {
      const data = await requestJson<OpenRouterModelList>({
        url: `${baseUrl}/models`,
        label,
        signal,
        headers: authHeaders(input.apiKey)
      })
      const models = parseOpenRouterModels(data)
      return catalog(
        input.provider,
        models,
        fetchedAt,
        `${baseUrl}/models`,
        models.filter((model) => model.free)
      )
    }
    case 'anthropic': {
      if (!input.apiKey) {
        throw new ProviderError('No Anthropic API key is stored.', undefined, 'Save a key in Settings first.')
      }
      const models: ModelOption[] = []
      let afterId: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const params = new URLSearchParams({ limit: '100' })
        if (afterId) params.set('after_id', afterId)
        const data = await requestJson<AnthropicModelList>({
          url: `${baseUrl}/v1/models?${params.toString()}`,
          label,
          signal,
          headers: {
            'x-api-key': input.apiKey,
            'anthropic-version': '2023-06-01'
          }
        })
        models.push(...parseAnthropicModels(data))
        if (!data.has_more || !data.last_id) break
        afterId = data.last_id
      }
      return catalog(input.provider, models, fetchedAt, `${baseUrl}/v1/models`)
    }
    case 'gemini': {
      if (!input.apiKey) {
        throw new ProviderError('No Google Gemini API key is stored.', undefined, 'Save a key in Settings first.')
      }
      const models: ModelOption[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const params = new URLSearchParams({ key: input.apiKey, pageSize: '1000' })
        if (pageToken) params.set('pageToken', pageToken)
        const data = await requestJson<GeminiModelList>({
          url: `${baseUrl}/models?${params.toString()}`,
          label,
          signal
        })
        models.push(...parseGeminiModels(data))
        if (!data.nextPageToken) break
        pageToken = data.nextPageToken
      }
      return catalog(input.provider, models, fetchedAt, `${baseUrl}/models`)
    }
    case 'ollama': {
      const root = baseUrl.replace(/\/v1$/, '')
      const data = await requestJson<OllamaTags>({
        url: `${root}/api/tags`,
        label,
        signal,
        headers: authHeaders(input.apiKey)
      })
      return catalog(input.provider, parseOllamaModels(data), fetchedAt, `${root}/api/tags`)
    }
    default: {
      const exhaustive: never = input.provider
      throw new ProviderError(`Unsupported model provider: ${String(exhaustive)}`)
    }
  }
}

function catalog(
  provider: ProviderId,
  models: ModelOption[],
  fetchedAt: number,
  source: string,
  freeModels: ModelOption[] = []
): ModelCatalog {
  const sorted = [...models].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
  return {
    provider,
    models: sorted,
    freeModels: rankFreeModels(freeModels.length ? freeModels : sorted.filter((model) => model.free)),
    fetchedAt,
    source
  }
}

/**
 * Picks the most capable free OpenRouter models. Tool support comes first
 * because the TagNest agent cannot operate Linux without tools; context size
 * breaks ties. If the API does not expose tool support, the free list is used
 * as-is instead of claiming a capability that was not reported.
 */
export function rankFreeModels(models: ModelOption[]): ModelOption[] {
  const free = models.filter((model) => model.free)
  const toolCapable = free.filter(
    (model) => !model.capabilities || model.capabilities.includes('tools')
  )
  const candidates = toolCapable.length > 0 ? toolCapable : free
  return [...candidates].sort(
    (left, right) =>
      (right.contextLength ?? 0) - (left.contextLength ?? 0) ||
      left.id.localeCompare(right.id)
  )
}

/** A free OpenRouter model can disappear or have its own quota; try the next one. */
export function isRetryableFreeModelError(error: unknown): boolean {
  return (
    error instanceof ProviderError &&
    typeof error.status === 'number' &&
    [403, 404, 429, 500, 502, 503, 504].includes(error.status)
  )
}

export function parseOpenAiModels(payload: OpenAiModelList, chatOnly: boolean): ModelOption[] {
  const models: ModelOption[] = []
  for (const entry of payload.data ?? []) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    if (chatOnly && !isChatModelId(id)) continue
    models.push({
      id,
      name: id,
      description: typeof entry.owned_by === 'string' ? entry.owned_by : undefined,
      capabilities: ['chat']
    })
  }
  return models
}

/** OpenAI's /models endpoint does not mark capabilities; skip obvious non-chat tools. */
export function isChatModelId(id: string): boolean {
  return !/(embedding|moderation|tts|whisper|transcribe|dall-e|image|audio|realtime|search|computer-use|instruct|davinci|babbage)/i.test(
    id
  )
}

interface OpenAiModelList {
  data?: Array<{ id?: string; owned_by?: string }>
}

interface OpenRouterModelList {
  data?: Array<{
    id?: string
    name?: string
    description?: string
    context_length?: number
    architecture?: {
      input_modalities?: string[]
      output_modalities?: string[]
      modality?: string
    }
    pricing?: Record<string, string | number>
    supported_parameters?: string[]
  }>
}

export function parseOpenRouterModels(payload: OpenRouterModelList): ModelOption[] {
  const models: ModelOption[] = []
  for (const entry of payload.data ?? []) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    const outputs = entry.architecture?.output_modalities
    if (outputs && !outputs.includes('text')) continue
    const inputs = entry.architecture?.input_modalities ?? []
    const capabilities = ['chat']
    if (entry.supported_parameters?.includes('tools')) capabilities.push('tools')
    if (inputs.includes('image') || entry.architecture?.modality?.includes('image')) {
      capabilities.push('vision')
    }
    const free =
      id.endsWith(':free') ||
      (Number(entry.pricing?.prompt) === 0 && Number(entry.pricing?.completion) === 0)
    models.push({
      id,
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 320) : undefined,
      contextLength: positiveNumber(entry.context_length),
      capabilities,
      free: free || undefined
    })
  }
  return models
}

interface AnthropicModelList {
  data?: Array<{ id?: string; display_name?: string; created_at?: string }>
  has_more?: boolean
  last_id?: string | null
}

export function parseAnthropicModels(payload: AnthropicModelList): ModelOption[] {
  const models: ModelOption[] = []
  for (const entry of payload.data ?? []) {
    const id = typeof entry.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    models.push({
      id,
      name: typeof entry.display_name === 'string' && entry.display_name.trim() ? entry.display_name.trim() : id,
      description: typeof entry.created_at === 'string' ? `Created ${entry.created_at}` : undefined,
      capabilities: ['chat']
    })
  }
  return models
}

interface GeminiModelList {
  models?: Array<{
    name?: string
    displayName?: string
    description?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
    supportedGenerationMethods?: string[]
  }>
  nextPageToken?: string
}

export function parseGeminiModels(payload: GeminiModelList): ModelOption[] {
  const models: ModelOption[] = []
  for (const entry of payload.models ?? []) {
    const rawName = typeof entry.name === 'string' ? entry.name.trim() : ''
    const id = rawName.replace(/^models\//, '')
    if (!id) continue
    const methods = entry.supportedGenerationMethods
    if (methods && !methods.includes('generateContent')) continue
    models.push({
      id,
      name:
        typeof entry.displayName === 'string' && entry.displayName.trim()
          ? entry.displayName.trim()
          : id,
      description: typeof entry.description === 'string' ? entry.description.slice(0, 320) : undefined,
      inputTokenLimit: positiveNumber(entry.inputTokenLimit),
      outputTokenLimit: positiveNumber(entry.outputTokenLimit),
      capabilities: ['chat']
    })
  }
  return models
}

interface OllamaTags {
  models?: Array<{
    name?: string
    model?: string
    details?: { family?: string; parameter_size?: string; quantization_level?: string }
  }>
}

export function parseOllamaModels(payload: OllamaTags): ModelOption[] {
  const models: ModelOption[] = []
  for (const entry of payload.models ?? []) {
    const id = (entry.name ?? entry.model ?? '').trim()
    if (!id || /embed/i.test(id)) continue
    const details = entry.details
    const description = details
      ? [details.family, details.parameter_size, details.quantization_level].filter(Boolean).join(' · ')
      : undefined
    models.push({
      id,
      name: id,
      description: description || undefined,
      capabilities: ['chat']
    })
  }
  return models
}

function positiveNumber(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : undefined
}

function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {}
}

async function requestJson<T>(options: {
  url: string
  label: string
  signal: AbortSignal
  headers?: Record<string, string>
}): Promise<T> {
  let response: Response
  try {
    response = await fetch(options.url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(options.headers ?? {})
      },
      signal: options.signal
    })
  } catch (error) {
    if (options.signal.aborted) {
      throw new ProviderError(`${options.label} model list request was cancelled or timed out.`)
    }
    const detail = error instanceof Error ? error.message : String(error)
    const local = /127\.0\.0\.1|localhost/.test(options.url)
    throw new ProviderError(
      `${options.label} did not answer the model list request. ${local ? 'Is the local server running?' : 'Check the endpoint and your internet connection.'} (${detail})`
    )
  }

  if (!response.ok) {
    const detail = await readErrorBody(response)
    throw new ProviderError(
      `${options.label} returned HTTP ${response.status} while listing models${detail ? `: ${detail}` : ''}`,
      response.status,
      modelsHint(response.status)
    )
  }

  return readJsonBody<T>(response, `${options.label} model list`)
}

function modelsHint(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'Check the API key in Settings. The provider rejected the credentials.'
  }
  if (status === 404) {
    return 'This endpoint does not expose a model list. You can still enter a model ID manually.'
  }
  if (status === 429) {
    return 'The provider is rate limiting the model list request. Try again shortly.'
  }
  if (status >= 500) return 'The provider reported a server error. Try again shortly.'
  return undefined
}
