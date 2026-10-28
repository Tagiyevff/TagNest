import { PROVIDERS, type ModelOption, type ProviderTestResult } from '../../shared/types'
import type { SecretsStore } from '../storage/secrets'
import type { SettingsStore } from '../storage/settings'
import { createProviderAdapter, ProviderError } from './providers'
import {
  fetchProviderModels,
  isRetryableFreeModelError,
  rankFreeModels
} from './providers/models'

/**
 * Sends one tiny, real request through the configured provider. It is the
 * only honest way to answer "will this key and endpoint work?" — no fabricated
 * success, no model list guessed from memory.
 *
 * In OpenRouter free-auto mode it walks the free models in rank order and
 * stops at the first one that actually answers. A model can be listed as free
 * but still refuse direct API traffic (403), so selecting the first ID without
 * testing it would not be honest.
 */
export async function testProviderConnection(
  settings: SettingsStore,
  secrets: SecretsStore
): Promise<ProviderTestResult> {
  const current = settings.get()
  const info = PROVIDERS.find((provider) => provider.id === current.provider)
  const apiKey = secrets.get(current.provider) ?? undefined

  if (info?.requiresApiKey && !apiKey) {
    return {
      ok: false,
      model: current.model,
      message: `No ${info.label} API key is stored. Paste a key above and save it first.`
    }
  }

  const freeAuto = current.provider === 'openrouter' && current.modelMode === 'free-auto'
  if (!current.model && !freeAuto) {
    return { ok: false, model: current.model, message: 'No model is selected. Choose one in Settings first.' }
  }

  const baseUrl = settings.resolveBaseUrl()
  let freeCandidates: ModelOption[] = []
  if (freeAuto) {
    try {
      const catalog = await fetchProviderModels({
        provider: 'openrouter',
        baseUrl,
        apiKey
      })
      freeCandidates = rankFreeModels(catalog.models)
      if (freeCandidates.length === 0) {
        return { ok: false, model: current.model, message: 'OpenRouter returned no free models right now.' }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const hint = error instanceof ProviderError ? error.hint : undefined
      return { ok: false, model: current.model, message: hint ? `${message} ${hint}` : message }
    }
  }

  const startedAt = Date.now()
  const candidates = freeAuto ? freeCandidates.slice(0, 8) : [{ id: current.model, name: current.model }]
  let lastError: unknown
  let model = candidates[0].id

  try {
    const adapter = createProviderAdapter(current.provider)
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      model = candidate.id
      const attemptStartedAt = Date.now()
      try {
        const response = await adapter.complete({
          model: candidate.id,
          system: 'You are a connectivity check for the TagNest desktop app. Answer in one short sentence.',
          turns: [{ role: 'user', text: 'Reply with the single word OK.' }],
          tools: [],
          baseUrl,
          apiKey,
          signal: AbortSignal.timeout(20_000)
        })
        const latencyMs = Date.now() - attemptStartedAt
        const reply = response.text.trim().replace(/\s+/g, ' ').slice(0, 200)
        return {
          ok: true,
          latencyMs,
          model: candidate.id,
          reply: reply || undefined,
          message: `Connected to ${candidate.id} in ${latencyMs} ms.`
        }
      } catch (error) {
        lastError = error
        const canTryNext =
          freeAuto && index < candidates.length - 1 && isRetryableFreeModelError(error)
        if (!canTryNext) throw error
      }
    }
    throw lastError
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = error instanceof ProviderError ? error.hint : undefined
    const prefix =
      freeAuto && candidates.length > 1
        ? `Tried ${candidates.length} free models. Last error: `
        : ''
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model,
      message: hint ? `${prefix}${message} ${hint}` : `${prefix}${message}`
    }
  }
}
