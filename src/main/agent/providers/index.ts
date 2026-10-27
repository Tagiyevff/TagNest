import type { ProviderId } from '../../../shared/types'
import { AnthropicAdapter } from './anthropic'
import { GeminiAdapter } from './gemini'
import { OpenAiCompatibleAdapter } from './openai'
import type { ProviderAdapter } from './types'

export * from './types'

export function createProviderAdapter(provider: ProviderId): ProviderAdapter {
  switch (provider) {
    case 'anthropic':
      return new AnthropicAdapter()
    case 'gemini':
      return new GeminiAdapter()
    case 'openai':
    case 'openrouter':
    case 'ollama':
    case 'custom':
      return new OpenAiCompatibleAdapter(provider)
    default: {
      const exhaustive: never = provider
      throw new Error(`Unsupported model provider: ${String(exhaustive)}`)
    }
  }
}
