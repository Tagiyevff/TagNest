import { PROVIDERS, type ProviderTestResult } from '../../shared/types'
import type { SecretsStore } from '../storage/secrets'
import type { SettingsStore } from '../storage/settings'
import { createProviderAdapter, ProviderError } from './providers'

/**
 * Sends one tiny, real request through the configured provider. It is the
 * only honest way to answer "will this key and endpoint work?" — no fabricated
 * success, no model list guessed from memory.
 */
export async function testProviderConnection(
  settings: SettingsStore,
  secrets: SecretsStore
): Promise<ProviderTestResult> {
  const current = settings.get()
  const info = PROVIDERS.find((provider) => provider.id === current.provider)
  const apiKey = secrets.get(current.provider) ?? undefined

  if (!current.model) {
    return { ok: false, model: current.model, message: 'No model is selected. Choose one in Settings first.' }
  }
  if (info?.requiresApiKey && !apiKey) {
    return {
      ok: false,
      model: current.model,
      message: `No ${info.label} API key is stored. Paste a key above and save it first.`
    }
  }

  const startedAt = Date.now()
  try {
    const adapter = createProviderAdapter(current.provider)
    const response = await adapter.complete({
      model: current.model,
      system: 'You are a connectivity check for the TagNest desktop app. Answer in one short sentence.',
      turns: [{ role: 'user', text: 'Reply with the single word OK.' }],
      tools: [],
      baseUrl: settings.resolveBaseUrl(),
      apiKey,
      signal: AbortSignal.timeout(30_000)
    })
    const latencyMs = Date.now() - startedAt
    const reply = response.text.trim().replace(/\s+/g, ' ').slice(0, 200)
    return {
      ok: true,
      latencyMs,
      model: current.model,
      reply: reply || undefined,
      message: `Connected to ${current.model} in ${latencyMs} ms.`
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = error instanceof ProviderError ? error.hint : undefined
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      model: current.model,
      message: hint ? `${message} ${hint}` : message
    }
  }
}
