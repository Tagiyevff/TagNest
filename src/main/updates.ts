import type { UpdateInfo } from '../shared/types'

export const RELEASES_PAGE = 'https://github.com/Tagiyevff/TagNest/releases'
const LATEST_RELEASE_API = 'https://api.github.com/repos/Tagiyevff/TagNest/releases/latest'

interface GithubRelease {
  tag_name?: unknown
  name?: unknown
  body?: unknown
  html_url?: unknown
  published_at?: unknown
  draft?: unknown
  prerelease?: unknown
}

/**
 * Compares dotted version strings. Returns 1 when `a` is newer than `b`, -1
 * when it is older and 0 when they are equal. A release is newer than a
 * prerelease with the same numeric core (`0.2.0` > `0.2.0-beta.1`), and build
 * metadata after `+` is ignored, per SemVer.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string): { core: number[]; prerelease: string[] } => {
    const cleaned = value.trim().replace(/^v/i, '').split('+')[0]
    const [corePart, prereleasePart] = cleaned.split('-', 2)
    return {
      core: corePart.split('.').map((part) => Number.parseInt(part, 10) || 0),
      prerelease: prereleasePart ? prereleasePart.split('.') : []
    }
  }

  const left = parse(a)
  const right = parse(b)
  const length = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < length; index += 1) {
    const difference = (left.core[index] ?? 0) - (right.core[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }

  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1

  const prereleaseLength = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < prereleaseLength; index += 1) {
    const leftPart = left.prerelease[index]
    const rightPart = right.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1
    } else if (leftNumber !== null) {
      return -1
    } else if (rightNumber !== null) {
      return 1
    } else if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1
    }
  }
  return 0
}

function text(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

/**
 * Turns the GitHub release payload into the shape the settings screen shows.
 * Drafts and prereleases are not offered as updates.
 */
export function parseRelease(release: GithubRelease | null, currentVersion: string): UpdateInfo {
  if (!release || release.draft === true || release.prerelease === true) {
    return {
      current: currentVersion,
      latest: null,
      updateAvailable: false,
      url: RELEASES_PAGE,
      message: release?.prerelease === true ? 'The latest release is a prerelease.' : 'No published release found.'
    }
  }
  const latest = text(release.tag_name, 80).replace(/^v/i, '')
  if (!latest) {
    return {
      current: currentVersion,
      latest: null,
      updateAvailable: false,
      url: RELEASES_PAGE,
      message: 'The latest release has no version tag.'
    }
  }
  return {
    current: currentVersion,
    latest,
    updateAvailable: compareVersions(latest, currentVersion) > 0,
    url: text(release.html_url, 500) || RELEASES_PAGE,
    name: text(release.name, 200) || undefined,
    notes: text(release.body, 4000) || undefined,
    publishedAt: text(release.published_at, 40) || undefined
  }
}

export async function checkForUpdates(
  currentVersion: string,
  fetchImpl: typeof fetch = fetch
): Promise<UpdateInfo> {
  let response: Response
  try {
    response = await fetchImpl(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `TagNest/${currentVersion}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      signal: AbortSignal.timeout(15_000)
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach GitHub Releases: ${reason}`)
  }

  if (response.status === 404) {
    return {
      current: currentVersion,
      latest: null,
      updateAvailable: false,
      url: RELEASES_PAGE,
      message: 'This repository has no published releases yet.'
    }
  }
  if (response.status === 403) {
    throw new Error('GitHub is rate-limiting update checks right now. Try again in a few minutes.')
  }
  if (!response.ok) {
    throw new Error(`GitHub Releases returned HTTP ${response.status}.`)
  }

  let payload: GithubRelease
  try {
    payload = (await response.json()) as GithubRelease
  } catch {
    throw new Error('GitHub Releases returned a response that is not valid JSON.')
  }
  return parseRelease(payload, currentVersion)
}
