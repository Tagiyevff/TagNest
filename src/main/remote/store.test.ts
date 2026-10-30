import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RemoteStore } from './store'

const dirs: string[] = []

function makeStore(): { dir: string; store: RemoteStore } {
  const dir = mkdtempSync(join(tmpdir(), 'tagnest-remote-'))
  dirs.push(dir)
  return { dir, store: new RemoteStore(dir) }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('RemoteStore', () => {
  it('starts disabled and with no devices', () => {
    const { store } = makeStore()
    const state = store.get()
    expect(state.enabled).toBe(false)
    expect(state.devices).toEqual([])
    expect(state.port).toBe(47821)
  })

  it('pairs once with the issued code and authenticates the token', () => {
    const { dir, store } = makeStore()
    const pairing = store.issuePairingCode()
    expect(pairing.code).toMatch(/^\d{6}$/)
    const paired = store.pair(pairing.code, 'Test phone')
    expect(paired).not.toBeNull()
    expect(paired?.device.name).toBe('Test phone')
    expect(store.authenticate(paired?.token)).toMatchObject({ name: 'Test phone' })
    expect(store.authenticate('not-a-real-token-value')).toBeNull()

    // The code is single use.
    expect(store.pair(pairing.code, 'Second phone')).toBeNull()

    // Only a hash reaches the disk, never the bearer token.
    const raw = readFileSync(join(dir, 'remote.json'), 'utf8')
    expect(raw).not.toContain(paired?.token)
    expect(raw).toContain('tokenHash')
  })

  it('persists devices across restarts', () => {
    const { dir, store } = makeStore()
    const pairing = store.issuePairingCode()
    const paired = store.pair(pairing.code, 'Persistent phone')!
    const reopened = new RemoteStore(dir)
    expect(reopened.devices()).toHaveLength(1)
    expect(reopened.authenticate(paired.token)?.id).toBe(paired.device.id)
  })

  it('rejects expired codes', () => {
    const { store } = makeStore()
    const now = Date.now()
    const pairing = store.issuePairingCode(now)
    expect(store.pair(pairing.code, 'Late phone', now + 16 * 60 * 1000)).toBeNull()
  })

  it('revokes a device immediately', () => {
    const { store } = makeStore()
    const pairing = store.issuePairingCode()
    const paired = store.pair(pairing.code, 'Phone')!
    expect(store.authenticate(paired.token)).not.toBeNull()
    expect(store.revoke(paired.device.id)).toBe(true)
    expect(store.authenticate(paired.token)).toBeNull()
    expect(store.revoke(paired.device.id)).toBe(false)
  })

  it('replaces an unused code when asked for a new one', () => {
    const { store } = makeStore()
    const first = store.ensurePairingCode()
    const second = store.ensurePairingCode()
    expect(second.code).toBe(first.code)
    const fresh = store.issuePairingCode()
    expect(store.ensurePairingCode().code).toBe(fresh.code)
  })
})
