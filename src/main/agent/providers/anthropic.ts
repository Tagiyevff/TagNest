import {
  ProviderError,
  combineSignals,
  readErrorBody,
  readJsonBody,
  type AgentTurn,
  type ProviderAdapter,
  type ProviderRequest,
  type ProviderResponse
} from './types'
import { hintForStatus } from './openai'

interface AnthropicBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: string
  is_error?: boolean
  source?: { type: 'base64'; media_type: string; data: string }
}

interface AnthropicResponse {
  content?: AnthropicBlock[]
  stop_reason?: string
  error?: { message?: string }
}

/** Anthropic Messages API adapter (also usable with Anthropic-compatible gateways). */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id = 'anthropic'

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const body = {
      model: request.model,
      max_tokens: 4096,
      temperature: 0.2,
      system: request.system,
      messages: toAnthropicMessages(request.turns),
      ...(request.tools.length
        ? {
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters
            }))
          }
        : {})
    }

    const response = await fetch(`${request.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': request.apiKey ?? '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body),
      signal: combineSignals(request.signal)
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      throw new ProviderError(`Could not reach Anthropic at ${request.baseUrl}. (${detail})`)
    })

    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new ProviderError(
        `Anthropic returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        hintForStatus(response.status)
      )
    }

    const data = await readJsonBody<AnthropicResponse>(response, 'Anthropic')
    const blocks = data.content ?? []
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n')
      .trim()
    const toolCalls = blocks
      .filter((block) => block.type === 'tool_use' && block.name)
      .map((block, index) => ({
        id: block.id ?? `toolu_${Date.now()}_${index}`,
        name: block.name as string,
        arguments: block.input ?? {}
      }))

    return { text, toolCalls, finishReason: data.stop_reason }
  }
}

export function toAnthropicMessages(
  turns: AgentTurn[]
): Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> {
  const messages: Array<{ role: 'user' | 'assistant'; content: AnthropicBlock[] }> = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      const content: AnthropicBlock[] = []
      for (const image of turn.images ?? []) {
        content.push({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.base64 } })
      }
      if (turn.text.trim()) content.push({ type: 'text', text: turn.text })
      messages.push({ role: 'user', content: content.length ? content : [{ type: 'text', text: ' ' }] })
    } else if (turn.role === 'assistant') {
      const content: AnthropicBlock[] = []
      if (turn.text) content.push({ type: 'text', text: turn.text })
      for (const call of turn.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments })
      }
      if (content.length) messages.push({ role: 'assistant', content })
    } else {
      const block: AnthropicBlock = {
        type: 'tool_result',
        tool_use_id: turn.toolCallId,
        content: turn.content,
        is_error: turn.isError
      }
      const last = messages[messages.length - 1]
      if (last?.role === 'user' && last.content.every((entry) => entry.type === 'tool_result')) {
        last.content.push(block)
      } else {
        messages.push({ role: 'user', content: [block] })
      }
    }
  }
  return messages
}
