import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkForUpdates, compareVersions, parseRelease, RELEASES_PAGE } from './updates'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('compareVersions', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.2.0', '0.1.9')).toBe(1)
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0)
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1)
  })

  it('treats a release as newer than its prerelease', () => {
    expect(compareVersions('0.2.0', '0.2.0-beta.1')).toBe(1)
    expect(compareVersions('0.2.0-beta.2', '0.2.0-beta.1')).toBe(1)
    expect(compareVersions('0.2.0-beta.1', '0.2.0')).toBe(-1)
  })

  it('ignores build metadata', () => {
    expect(compareVersions('1.2.3+build.5', '1.2.3')).toBe(0)
  })
})

describe('parseRelease', () => {
  it('reports a newer GitHub release', () => {
    const info = parseRelease(
      {
        tag_name: 'v0.2.0',
        name: 'TagNest 0.2.0',
        body: 'File bridge',
        html_url: 'https://github.com/Tagiyevff/TagNest/releases/tag/v0.2.0',
        published_at: '2026-10-28T10:00:00Z'
      },
      '0.1.0'
    )
    expect(info.latest).toBe('0.2.0')
    expect(info.updateAvailable).toBe(true)
    expect(info.url).toContain('/tag/v0.2.0')
    expect(info.notes).toBe('File bridge')
  })

  it('does not offer the same or an older version as an update', () => {
    expect(parseRelease({ tag_name: 'v0.1.0' }, '0.1.0').updateAvailable).toBe(false)
    expect(parseRelease({ tag_name: 'v0.0.9' }, '0.1.0').updateAvailable).toBe(false)
  })

  it('ignores drafts and prereleases', () => {
    expect(parseRelease({ tag_name: 'v0.3.0', draft: true }, '0.1.0').latest).toBeNull()
    expect(parseRelease({ tag_name: 'v0.3.0', prerelease: true }, '0.1.0').latest).toBeNull()
  })

  it('handles a missing tag and an empty payload', () => {
    expect(parseRelease({}, '0.1.0').latest).toBeNull()
    expect(parseRelease(null, '0.1.0')).toMatchObject({
      current: '0.1.0',
      latest: null,
      updateAvailable: false,
      url: RELEASES_PAGE
    })
  })
})

describe('checkForUpdates', () => {
  it('parses a real GitHub-style response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            tag_name: 'v0.2.0',
            name: 'TagNest 0.2.0',
            body: 'Notes',
            html_url: 'https://github.com/Tagiyevff/TagNest/releases/tag/v0.2.0'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    )
    const info = await checkForUpdates('0.1.0')
    expect(info.updateAvailable).toBe(true)
    expect(info.latest).toBe('0.2.0')
  })

  it('returns a friendly result when no release exists', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    const info = await checkForUpdates('0.1.0')
    expect(info.updateAvailable).toBe(false)
    expect(info.message).toContain('no published releases')
  })

  it('explains rate limiting and network failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })))
    await expect(checkForUpdates('0.1.0')).rejects.toThrow(/rate-limiting/i)

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND api.github.com')
      })
    )
    await expect(checkForUpdates('0.1.0')).rejects.toThrow(/Could not reach GitHub Releases/)
  })
})
