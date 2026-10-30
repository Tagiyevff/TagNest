import { describe, expect, it } from 'vitest'
import { parseTargetList, pickPageTarget, rewriteWebSocketUrl, validateBrowserUrl } from './browser'

describe('validateBrowserUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(validateBrowserUrl('https://example.com/a?b=1')).toBeNull()
    expect(validateBrowserUrl('http://127.0.0.1:8080/')).toBeNull()
  })

  it('rejects other schemes and malformed input', () => {
    expect(validateBrowserUrl('')).toMatch(/required/i)
    expect(validateBrowserUrl('file:///etc/passwd')).toMatch(/http/i)
    expect(validateBrowserUrl('javascript:alert(1)')).toMatch(/http/i)
    expect(validateBrowserUrl('chrome://settings')).toMatch(/http/i)
    expect(validateBrowserUrl('https://example.com/a b')).toMatch(/whitespace/i)
    expect(validateBrowserUrl(`https://example.com/${'a'.repeat(2048)}`)).toMatch(/too long/i)
  })
})

describe('pickPageTarget', () => {
  it('selects a real page and ignores workers and service targets', () => {
    const target = pickPageTarget([
      { id: 'worker', type: 'service_worker', webSocketDebuggerUrl: 'ws://x/devtools/page/worker' },
      { id: 'blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://x/devtools/page/blank' },
      {
        id: 'page',
        type: 'page',
        url: 'https://example.com/',
        title: 'Example',
        webSocketDebuggerUrl: 'ws://x/devtools/page/page'
      }
    ])
    expect(target?.id).toBe('page')
  })

  it('falls back to the blank page and returns null when there is no page', () => {
    expect(
      pickPageTarget([{ id: 'blank', type: 'page', url: 'about:blank', webSocketDebuggerUrl: 'ws://x/devtools/page/b' }])
        ?.id
    ).toBe('blank')
    expect(pickPageTarget([{ id: 'bg', type: 'background_page' }])).toBeNull()
    expect(pickPageTarget([])).toBeNull()
  })
})

describe('rewriteWebSocketUrl', () => {
  it('rewrites the guest port to the local forwarded port', () => {
    expect(rewriteWebSocketUrl('ws://127.0.0.1:9222/devtools/page/ABC?x=1', 5555)).toBe(
      'ws://127.0.0.1:5555/devtools/page/ABC?x=1'
    )
  })

  it('refuses non-devtools and non-websocket addresses', () => {
    expect(rewriteWebSocketUrl('http://127.0.0.1:9222/json/list', 5555)).toBeNull()
    expect(rewriteWebSocketUrl('ws://127.0.0.1:9222/json/list', 5555)).toBeNull()
    expect(rewriteWebSocketUrl('not a url', 5555)).toBeNull()
  })
})

describe('parseTargetList', () => {
  it('parses the real /json/list array', () => {
    const targets = parseTargetList(
      '[{"id":"1","type":"page","url":"https://example.com","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/page/1"}]\n'
    )
    expect(targets).toHaveLength(1)
    expect(targets[0].url).toBe('https://example.com')
  })

  it('returns an empty list for invalid or non-array payloads', () => {
    expect(parseTargetList('')).toEqual([])
    expect(parseTargetList('not json')).toEqual([])
    expect(parseTargetList('{"id":"1"}')).toEqual([])
  })
})
