import {
  ProviderError,
  combineSignals,
  parseToolArguments,
  readErrorBody,
  readJsonBody,
  type AgentTurn,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse
} from './types'

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null | OpenAiContentPart[]
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string
  }>
  error?: { message?: string }
}

/**
 * OpenAI Chat Completions adapter. Also used by OpenRouter, Ollama's
 * OpenAI-compatible endpoint and any custom compatible server.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  constructor(readonly id: string) {}

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const messages = toOpenAiMessages(request.system, request.turns)
    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      temperature: 0.2
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
      body.tool_choice = 'auto'
    }

    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`

    const response = await fetch(`${request.baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combineSignals(request.signal)
    }).catch((error: unknown) => {
      throw new ProviderError(networkMessage(request.baseUrl, error))
    })

    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new ProviderError(
        `${providerLabel(this.id)} returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        hintForStatus(response.status)
      )
    }

    const data = await readJsonBody<OpenAiResponse>(response, providerLabel(this.id))
    const message = data.choices?.[0]?.message
    if (!message) {
      throw new ProviderError('The model response did not contain a message.')
    }
    const toolCalls = (message.tool_calls ?? [])
      .filter((call) => call.function?.name)
      .map((call, index) => ({
        id: call.id || `call_${Date.now()}_${index}`,
        name: call.function?.name ?? '',
        arguments: parseToolArguments(call.function?.arguments ?? '')
      }))

    return {
      text: message.content?.trim() ?? '',
      toolCalls,
      finishReason: data.choices?.[0]?.finish_reason
    }
  }
}

export function toOpenAiMessages(system: string, turns: AgentTurn[]): OpenAiMessage[] {
  const messages: OpenAiMessage[] = [{ role: 'system', content: system }]
  for (const turn of turns) {
    if (turn.role === 'user') {
      if (turn.images?.length) {
        // Chat Completions expects images as content parts in a user message.
        const parts: OpenAiContentPart[] = []
        if (turn.text.trim()) parts.push({ type: 'text', text: turn.text })
        for (const image of turn.images) {
          parts.push({
            type: 'image_url',
            image_url: { url: `data:${image.mimeType};base64,${image.base64}` }
          })
        }
        messages.push({ role: 'user', content: parts })
      } else {
        messages.push({ role: 'user', content: turn.text })
      }
    } else if (turn.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        ...(turn.toolCalls.length
          ? {
              tool_calls: turn.toolCalls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.arguments) }
              }))
            }
          : {})
      })
    } else {
      messages.push({
        role: 'tool',
        content: turn.content,
        tool_call_id: turn.toolCallId
      })
    }
  }
  return messages
}

function providerLabel(id: string): string {
  switch (id) {
    case 'openrouter':
      return 'OpenRouter'
    case 'ollama':
      return 'Ollama'
    case 'custom':
      return 'The configured OpenAI-compatible server'
    default:
      return 'OpenAI'
  }
}

export function hintForStatus(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return 'Check the API key in Settings. The provider rejected the credentials.'
  }
  if (status === 404) {
    return 'Check the model name and base URL in Settings. The provider did not find that endpoint.'
  }
  if (status === 429) {
    return 'The provider is rate limiting requests or the account has no quota left. Try again later.'
  }
  if (status >= 500) {
    return 'The provider reported a server error. Try again shortly.'
  }
  return undefined
}

function networkMessage(baseUrl: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  if (/abort/i.test(detail)) return 'The model request was cancelled.'
  if (baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost')) {
    return `Could not reach the local model server at ${baseUrl}. Is it running? (${detail})`
  }
  return `Could not reach the model provider at ${baseUrl}. Check your internet connection. (${detail})`
}
