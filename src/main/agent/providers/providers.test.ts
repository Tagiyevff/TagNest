import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { AnthropicAdapter } from './anthropic'
import { GeminiAdapter } from './gemini'
import { OpenAiCompatibleAdapter } from './openai'
import { ProviderError, type ProviderRequest } from './types'

interface MockServer {
  url: string
  close: () => Promise<void>
  requests: Array<{ url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }>
}

const servers: MockServer[] = []

async function mockServer(
  handler: (body: Record<string, unknown>, response: ServerResponse, request: IncomingMessage) => void
): Promise<MockServer> {
  const requests: MockServer['requests'] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
      } catch {
        body = { __raw: Buffer.concat(chunks).toString('utf8') }
      }
      requests.push({ url: request.url ?? '', headers: request.headers, body })
      handler(body, response, request)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server did not start')
  const mock: MockServer = {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  }
  servers.push(mock)
  return mock
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

const baseRequest: Omit<ProviderRequest, 'baseUrl'> = {
  model: 'test-model',
  system: 'system prompt',
  turns: [
    { role: 'user', text: 'list the workspace' },
    { role: 'assistant', text: 'I will look.', toolCalls: [{ id: 'call_1', name: 'list_files', arguments: { path: '.' } }] },
    { role: 'tool', toolCallId: 'call_1', name: 'list_files', content: 'a.txt', isError: false }
  ],
  tools: [
    {
      name: 'list_files',
      description: 'List files',
      parameters: { type: 'object', properties: { path: { type: 'string' } } }
    }
  ]
}

describe('OpenAI-compatible adapter', () => {
  it('sends tools and parses function calls', async () => {
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: 'Checking files.',
                tool_calls: [
                  { id: 'call_2', type: 'function', function: { name: 'list_files', arguments: '{"path":"/home/tagnest/workspace"}' } }
                ]
              }
            }
          ]
        })
      )
    })
    const adapter = new OpenAiCompatibleAdapter('openai')
    const result = await adapter.complete({ ...baseRequest, baseUrl: mock.url, apiKey: 'test-key' })

    expect(result.text).toBe('Checking files.')
    expect(result.toolCalls).toEqual([
      { id: 'call_2', name: 'list_files', arguments: { path: '/home/tagnest/workspace' } }
    ])
    expect(mock.requests[0].url).toBe('/chat/completions')
    expect(mock.requests[0].headers.authorization).toBe('Bearer test-key')
    const messages = mock.requests[0].body.messages as Array<Record<string, unknown>>
    expect(messages[0].role).toBe('system')
    expect(messages[2]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1' }] })
    expect(messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect((mock.requests[0].body.tools as unknown[]).length).toBe(1)
  })

  it('surfaces provider errors with a helpful hint', async () => {
    const mock = await mockServer((_body, response) => {
      response.statusCode = 401
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ error: { message: 'invalid api key' } }))
    })
    const adapter = new OpenAiCompatibleAdapter('openai')
    await expect(adapter.complete({ ...baseRequest, baseUrl: mock.url, apiKey: 'bad' })).rejects.toMatchObject({
      name: 'ProviderError',
      status: 401
    })
    try {
      await adapter.complete({ ...baseRequest, baseUrl: mock.url, apiKey: 'bad' })
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError)
      expect((error as ProviderError).hint).toMatch(/API key/i)
    }
  })
})

describe('screenshots for vision models', () => {
  const image = { mimeType: 'image/png', base64: 'iVBORw0KGgo=', width: 1440, height: 900 }
  const turnsWithImage = [{ role: 'user' as const, text: 'What is on screen?', images: [image] }]

  it('sends images as data URLs in OpenAI-compatible content parts', async () => {
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ choices: [{ message: { content: 'A desktop.' } }] }))
    })
    await new OpenAiCompatibleAdapter('custom').complete({ ...baseRequest, baseUrl: mock.url, turns: turnsWithImage })
    const messages = mock.requests[0].body.messages as Array<{ role: string; content: unknown }>
    const parts = messages[1].content as Array<{ type: string; image_url?: { url: string } }>
    expect(parts[0]).toMatchObject({ type: 'text', text: 'What is on screen?' })
    expect(parts[1]).toMatchObject({ type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } })
  })

  it('sends base64 image blocks to Anthropic', async () => {
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }))
    })
    await new AnthropicAdapter().complete({ ...baseRequest, baseUrl: mock.url, turns: turnsWithImage })
    const messages = mock.requests[0].body.messages as Array<{ role: string; content: unknown[] }>
    expect(messages[0].content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' }
    })
  })

  it('sends inlineData parts to Gemini', async () => {
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }))
    })
    await new GeminiAdapter().complete({ ...baseRequest, baseUrl: mock.url, turns: turnsWithImage })
    const contents = mock.requests[0].body.contents as Array<{ role: string; parts: unknown[] }>
    expect(contents[0].parts[0]).toMatchObject({ inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' } })
  })
})

describe('provider response parsing', () => {
  it('accepts a JSON document that a gateway appended data to', async () => {
    const completion = JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: 'Still fine.' } }]
    })
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(`${completion}\n{"usage_extra":true,"note":"appended by the router"}`)
    })
    const adapter = new OpenAiCompatibleAdapter('custom')
    const result = await adapter.complete({ ...baseRequest, baseUrl: mock.url })
    expect(result.text).toBe('Still fine.')
  })

  it('reports a non-JSON body instead of leaking a JSON syntax error', async () => {
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<html><body>gateway maintenance</body></html>')
    })
    const adapter = new OpenAiCompatibleAdapter('custom')
    const failure = await adapter.complete({ ...baseRequest, baseUrl: mock.url }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProviderError)
    expect((failure as ProviderError).message).toMatch(/not valid JSON/i)
    expect((failure as ProviderError).message).toMatch(/text\/html/)
    expect((failure as ProviderError).hint).toMatch(/base URL/i)
  })

  it('reports an empty body', async () => {
    const mock = await mockServer((_body, response) => response.end(''))
    const adapter = new OpenAiCompatibleAdapter('custom')
    await expect(adapter.complete({ ...baseRequest, baseUrl: mock.url })).rejects.toMatchObject({
      name: 'ProviderError'
    })
  })
})

describe('Anthropic adapter', () => {
  it('maps tool results and parses tool_use blocks', async () => {
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Listing.' },
            { type: 'tool_use', id: 'toolu_1', name: 'list_files', input: { path: '.' } }
          ]
        })
      )
    })
    const adapter = new AnthropicAdapter()
    const result = await adapter.complete({ ...baseRequest, baseUrl: mock.url, apiKey: 'anthropic-key' })

    expect(result.text).toBe('Listing.')
    expect(result.toolCalls[0]).toMatchObject({ id: 'toolu_1', name: 'list_files' })
    expect(mock.requests[0].url).toBe('/v1/messages')
    expect(mock.requests[0].headers['x-api-key']).toBe('anthropic-key')
    expect(mock.requests[0].headers['anthropic-version']).toBeDefined()
    const messages = mock.requests[0].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages[1].content[1]).toMatchObject({ type: 'tool_use', id: 'call_1' })
    expect(messages[2]).toMatchObject({ role: 'user' })
    expect(messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' })
  })
})

describe('Gemini adapter', () => {
  it('uses generateContent with function declarations and responses', async () => {
    const mock = await mockServer((_body, response) => {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          candidates: [
            {
              finishReason: 'STOP',
              content: {
                parts: [{ functionCall: { name: 'list_files', args: { path: '.' } } }]
              }
            }
          ]
        })
      )
    })
    const adapter = new GeminiAdapter()
    const result = await adapter.complete({ ...baseRequest, baseUrl: mock.url, apiKey: 'gemini-key' })

    expect(result.toolCalls[0]).toMatchObject({ name: 'list_files', arguments: { path: '.' } })
    expect(mock.requests[0].url).toContain('/models/test-model:generateContent')
    expect(mock.requests[0].url).toContain('key=gemini-key')
    const body = mock.requests[0].body as { tools: Array<{ functionDeclarations: unknown[] }>; contents: unknown[] }
    expect(body.tools[0].functionDeclarations.length).toBe(1)
    expect(JSON.stringify(body.contents)).toContain('functionResponse')
  })
})
