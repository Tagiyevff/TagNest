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

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: Record<string, unknown> }
  functionResponse?: { name?: string; response?: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[]; role?: string }
    finishReason?: string
  }>
  error?: { message?: string }
}

/** Google Gemini generateContent adapter. */
export class GeminiAdapter implements ProviderAdapter {
  readonly id = 'gemini'

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: toGeminiContents(request.turns),
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
      ...(request.tools.length
        ? {
            tools: [
              {
                functionDeclarations: request.tools.map((tool) => ({
                  name: tool.name,
                  description: tool.description,
                  parameters: sanitizeSchema(tool.parameters as unknown as Record<string, unknown>)
                }))
              }
            ]
          }
        : {})
    }

    const url = `${request.baseUrl}/models/${encodeURIComponent(request.model)}:generateContent?key=${encodeURIComponent(request.apiKey ?? '')}`
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: combineSignals(request.signal)
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      throw new ProviderError(`Could not reach Google Gemini at ${request.baseUrl}. (${detail})`)
    })

    if (!response.ok) {
      const detail = await readErrorBody(response)
      throw new ProviderError(
        `Gemini returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
        response.status,
        hintForStatus(response.status)
      )
    }

    const data = await readJsonBody<GeminiResponse>(response, 'Google Gemini')
    const parts = data.candidates?.[0]?.content?.parts ?? []
    const text = parts
      .filter((part) => typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()
    const toolCalls = parts
      .filter((part) => part.functionCall?.name)
      .map((part, index) => ({
        id: `gemini_${Date.now()}_${index}`,
        name: part.functionCall?.name ?? '',
        arguments: part.functionCall?.args ?? {}
      }))

    return {
      text,
      toolCalls,
      finishReason: data.candidates?.[0]?.finishReason
    }
  }
}

export function toGeminiContents(
  turns: AgentTurn[]
): Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> {
  const contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }> = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      const parts: GeminiPart[] = []
      for (const image of turn.images ?? []) {
        parts.push({ inlineData: { mimeType: image.mimeType, data: image.base64 } })
      }
      parts.push({ text: turn.text })
      contents.push({ role: 'user', parts })
    } else if (turn.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (turn.text) parts.push({ text: turn.text })
      for (const call of turn.toolCalls) {
        parts.push({ functionCall: { name: call.name, args: call.arguments } })
      }
      if (parts.length) contents.push({ role: 'model', parts })
    } else {
      // Gemini expects function responses from the "user" role.
      const response: GeminiPart = {
        functionResponse: { name: turn.name, response: { output: turn.content } }
      }
      const last = contents[contents.length - 1]
      if (last?.role === 'user' && last.parts.every((part) => part.functionResponse)) {
        last.parts.push(response)
      } else {
        contents.push({ role: 'user', parts: [response] })
      }
    }
  }
  return contents
}

/** Gemini rejects several JSON-schema keywords (additionalProperties, $schema). */
function sanitizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' || key === '$schema') continue
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      clone[key] = sanitizeSchema(value as Record<string, unknown>)
    } else if (Array.isArray(value)) {
      clone[key] = value.map((entry) =>
        entry && typeof entry === 'object' ? sanitizeSchema(entry as Record<string, unknown>) : entry
      )
    } else {
      clone[key] = value
    }
  }
  return clone
}
