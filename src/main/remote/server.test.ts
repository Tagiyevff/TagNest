import { describe, expect, it } from 'vitest'
import type { RuntimeState } from '../../shared/types'
import { normalizeCustomUrl } from './remote'
import { parseCookies, publicRuntime } from './server'

describe('parseCookies', () => {
  it('reads and decodes cookie values', () => {
    expect(parseCookies('tagnest_remote=abc%2Fdef; theme=dark')).toEqual({
      tagnest_remote: 'abc/def',
      theme: 'dark'
    })
  })

  it('ignores malformed pairs', () => {
    expect(parseCookies('nonsense; =value; good=1')).toEqual({ good: '1' })
    expect(parseCookies(undefined)).toEqual({})
  })
})

describe('publicRuntime', () => {
  it('removes the VNC URL, SSH port and local log path before sending state to a phone', () => {
    const state: RuntimeState = {
      phase: 'running',
      message: 'Linux is running',
      acceleration: 'whpx',
      vncUrl: 'ws://127.0.0.1:4444/?token=secret',
      sshPort: 2222,
      logPath: 'C:\\Users\\person\\AppData\\TagNest\\serial.log',
      memoryMB: 3072,
      cpus: 2,
      qemuFound: true,
      qemuCanInstall: true,
      qemuInstalling: false
    }
    const safe = publicRuntime(state)
    expect(safe).not.toHaveProperty('vncUrl')
    expect(safe).not.toHaveProperty('sshPort')
    expect(safe).not.toHaveProperty('logPath')
    expect(safe.phase).toBe('running')
    expect(safe.memoryMB).toBe(3072)
  })
})

describe('normalizeCustomUrl', () => {
  it('accepts a bare https origin', () => {
    expect(normalizeCustomUrl('https://nest.example.com')).toBe('https://nest.example.com')
    expect(normalizeCustomUrl('  https://nest.example.com/  ')).toBe('https://nest.example.com')
    expect(normalizeCustomUrl('http://192.168.1.20:8787')).toBe('http://192.168.1.20:8787')
  })

  it('rejects unsupported or ambiguous URLs', () => {
    expect(normalizeCustomUrl('')).toBe('')
    expect(normalizeCustomUrl('ftp://example.com')).toBe('')
    expect(normalizeCustomUrl('https://example.com/path')).toBe('')
    expect(normalizeCustomUrl('https://user:pass@example.com')).toBe('')
    expect(normalizeCustomUrl('not a url')).toBe('')
  })
})
