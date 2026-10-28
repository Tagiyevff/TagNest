import { PROVIDERS, type ProviderModelsResult } from '../../shared/types'
import type { SecretsStore } from '../storage/secrets'
import type { SettingsStore } from '../storage/settings'
import { fetchProviderModels } from './providers/models'
import { ProviderError } from './providers'

/**
 * Lists the models of the provider currently selected in Settings, using the
 * resolved endpoint and the stored key. The result is only a cache-free view
 * of the provider API: a refresh is a real second request.
 */
export async function listConfiguredProviderModels(
  settings: SettingsStore,
  secrets: SecretsStore
): Promise<ProviderModelsResult> {
  const current = settings.get()
  const info = PROVIDERS.find((provider) => provider.id === current.provider)
  const apiKey = secrets.get(current.provider) ?? undefined

  if (info?.requiresApiKey && !apiKey) {
    return {
      ok: false,
      provider: current.provider,
      message: `No ${info.label} API key is stored. Save a key in Settings, then refresh the model list.`
    }
  }

  try {
    const catalog = await fetchProviderModels({
      provider: current.provider,
      baseUrl: settings.resolveBaseUrl(),
      apiKey
    })
    return { ok: true, provider: current.provider, catalog }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const hint = error instanceof ProviderError ? error.hint : undefined
    return {
      ok: false,
      provider: current.provider,
      message: hint ? `${message} ${hint}` : message
    }
  }
}
