import { redactSecrets } from '../../redact'
import { logger } from '../../logger'

export interface ToolParameterSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameterSchema
}

export interface ProviderToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

/** A real image (currently: a screenshot of the guest desktop) for a vision model. */
export interface ProviderImage {
  mimeType: string
  base64: string
  width?: number
  height?: number
}

export type AgentTurn =
  | { role: 'user'; text: string; images?: ProviderImage[] }
  | { role: 'assistant'; text: string; toolCalls: ProviderToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError: boolean }

export interface ProviderRequest {
  model: string
  system: string
  turns: AgentTurn[]
  tools: ToolDefinition[]
  baseUrl: string
  apiKey?: string
  signal?: AbortSignal
}

export interface ProviderResponse {
  text: string
  toolCalls: ProviderToolCall[]
  finishReason?: string
}

export interface ProviderAdapter {
  readonly id: string
  complete(request: ProviderRequest): Promise<ProviderResponse>
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly hint?: string
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export const PROVIDER_TIMEOUT_MS = 180_000

export function combineSignals(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(PROVIDER_TIMEOUT_MS)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Reads a provider response body as JSON without blowing up on real-world
 * gateways. Local routers and proxies sometimes append data after the JSON
 * document (a second object, a trailer, padding), which makes a plain
 * `response.json()` throw a raw `SyntaxError` the user cannot act on.
 *
 * Strategy: parse the whole body; if that fails, parse the first complete JSON
 * value; if that fails too, raise a ProviderError that says what the endpoint
 * actually answered.
 */
export async function readJsonBody<T>(response: Response, label: string): Promise<T> {
  const raw = await response.text().catch(() => '')
  const text = raw.trim()
  if (!text) {
    throw new ProviderError(
      `${label} returned an empty response (HTTP ${response.status}).`,
      response.status,
      'Check the base URL in Settings: the endpoint answered without a body.'
    )
  }

  try {
    return JSON.parse(text) as T
  } catch {
    const complete = extractFirstJsonValue(text)
    if (complete) {
      const trailing = text.slice(complete.length).trim()
      const streamTerminator = /^data:\s*\[DONE\]$/i.test(trailing)
      const detail = `trailing data after the JSON document (body ${text.length} bytes, JSON ${complete.length} bytes): ${redactSecrets(
        trailing.slice(0, 240)
      )}`
      // A SSE `data: [DONE]` terminator appended to a non-streaming response is
      // a known gateway quirk: recover silently. Anything else is worth a warn.
      if (streamTerminator) logger.debug('provider', `${label}: ${detail}`)
      else logger.warn('provider', `${label}: ${detail}`)
      try {
        return JSON.parse(complete) as T
      } catch {
        /* fall through to the explicit error below */
      }
    }

    const contentType = response.headers.get('content-type') ?? 'unknown content type'
    const snippet = redactSecrets(text.slice(0, 300))
    logger.warn(
      'provider',
      `${label}: response is not valid JSON (HTTP ${response.status}, ${contentType}, ${text.length} bytes): ${snippet}`
    )
    throw new ProviderError(
      `${label} returned HTTP ${response.status} with a body that is not valid JSON (${contentType}, ${text.length} bytes). It starts with: ${snippet}`,
      response.status,
      'Check the base URL in Settings: this endpoint did not answer like an OpenAI-compatible API.'
    )
  }
}

/** Returns the first balanced JSON object/array in `text`, or null. */
function extractFirstJsonValue(text: string): string | null {
  const start = text.search(/[[{]/)
  if (start === -1) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
    } else if (character === open) {
      depth += 1
    } else if (character === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return null
}

export async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = await response.text()
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string
        message?: string
      }
      if (typeof parsed.error === 'string') return parsed.error
      if (parsed.error?.message) return parsed.error.message
      if (parsed.message) return parsed.message
    } catch {
      /* plain text body */
    }
    return text.slice(0, 800)
  } catch {
    return ''
  }
}

export function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return { value: parsed }
  } catch {
    return { __invalid_arguments: raw.slice(0, 400) }
  }
}
