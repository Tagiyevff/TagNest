import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import { describe, expect, it, vi, type Mock } from 'vitest'
import { GUEST_WORKSPACE } from '../linux/guest'
import type { GuestClient } from '../linux/ssh'
import { downloadWorkspaceFile, listWorkspace, sanitizeUploadPath } from './files'

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn()
  }
}))

type StubGuest = {
  realpath: (path: string) => Promise<string>
  list: (path: string) => Promise<
    Array<{ name: string; type: 'file' | 'directory' | 'symlink' | 'other'; size: number; modified: number; mode: number }>
  >
}

function stubGuest(overrides: Partial<StubGuest> = {}): GuestClient {
  const guest: StubGuest = {
    realpath: async (path: string) => path,
    list: async () => [
      { name: 'zeta.txt', type: 'file', size: 12, modified: 0, mode: 0o100644 },
      { name: 'alpha', type: 'directory', size: 0, modified: 0, mode: 0o040755 },
      { name: '..', type: 'directory', size: 0, modified: 0, mode: 0o040755 }
    ],
    ...overrides
  }
  return guest as unknown as GuestClient
}

describe('sanitizeUploadPath', () => {
  it('keeps nested relative paths', () => {
    expect(sanitizeUploadPath('notes.txt')).toBe('notes.txt')
    expect(sanitizeUploadPath('project/src/index.ts')).toBe('project/src/index.ts')
    expect(sanitizeUploadPath('windows\\style\\file.txt')).toBe('windows/style/file.txt')
  })

  it('strips a leading slash so it stays inside the workspace', () => {
    expect(sanitizeUploadPath('/etc/passwd')).toBe('etc/passwd')
    expect(sanitizeUploadPath('./file.txt')).toBe('file.txt')
  })

  it('rejects traversal, empty segments and null bytes', () => {
    expect(sanitizeUploadPath('../escape.txt')).toBeNull()
    expect(sanitizeUploadPath('project/../../escape.txt')).toBeNull()
    expect(sanitizeUploadPath('project//file.txt')).toBeNull()
    expect(sanitizeUploadPath('./../file.txt')).toBeNull()
    expect(sanitizeUploadPath('bad\0name.txt')).toBeNull()
    expect(sanitizeUploadPath('')).toBeNull()
  })
})

describe('listWorkspace', () => {
  it('lists the workspace root with directories first and no dot entries', async () => {
    const listing = await listWorkspace(stubGuest())
    expect(listing.path).toBe(GUEST_WORKSPACE)
    expect(listing.relative).toBe('')
    expect(listing.parent).toBeNull()
    expect(listing.entries.map((entry) => entry.name)).toEqual(['alpha', 'zeta.txt'])
    expect(listing.entries[1].relative).toBe('zeta.txt')
    expect(listing.entries[1].path).toBe(`${GUEST_WORKSPACE}/zeta.txt`)
  })

  it('lists a subfolder with a parent link', async () => {
    const listing = await listWorkspace(stubGuest(), `${GUEST_WORKSPACE}/project`)
    expect(listing.relative).toBe('project')
    expect(listing.parent).toBe(GUEST_WORKSPACE)
  })

  it('refuses paths outside the workspace', async () => {
    await expect(listWorkspace(stubGuest(), '/etc')).rejects.toThrow(/outside the TagNest workspace/)
    await expect(listWorkspace(stubGuest(), '../../etc')).rejects.toThrow(/outside the TagNest workspace/)
  })

  it('refuses a symlink that resolves outside the workspace', async () => {
    const guest = stubGuest({ realpath: async () => '/etc' })
    await expect(listWorkspace(guest, `${GUEST_WORKSPACE}/link`)).rejects.toThrow(/outside the TagNest workspace/)
  })
})

describe('downloadWorkspaceFile', () => {
  function downloadGuest(write: (local: string) => void): GuestClient {
    return {
      realpath: async (path: string) => path,
      stat: async () => ({ name: 'report.txt', type: 'file', size: 5, modified: 0, mode: 0o100644 }),
      downloadFile: async (_remote: string, local: string) => write(local)
    } as unknown as GuestClient
  }

  it('writes the chosen file to the host path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tagnest-download-'))
    const target = join(dir, 'report.txt')
    ;(dialog.showSaveDialog as unknown as Mock).mockResolvedValue({ canceled: false, filePath: target })
    try {
      const result = await downloadWorkspaceFile(
        downloadGuest((local) => writeFileSync(local, 'hello')),
        `${GUEST_WORKSPACE}/report.txt`,
        {} as BrowserWindow
      )
      expect(result).toEqual({ ok: true, path: target })
      expect(readFileSync(target, 'utf8')).toBe('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a cancelled dialog without writing anything', async () => {
    ;(dialog.showSaveDialog as unknown as Mock).mockResolvedValue({ canceled: true, filePath: '' })
    const result = await downloadWorkspaceFile(
      downloadGuest(() => undefined),
      `${GUEST_WORKSPACE}/report.txt`,
      {} as BrowserWindow
    )
    expect(result).toEqual({ ok: false, canceled: true })
  })

  it('refuses a path outside the workspace before opening a dialog', async () => {
    const result = await downloadWorkspaceFile(
      downloadGuest(() => undefined),
      '/etc/passwd',
      {} as BrowserWindow
    )
    expect(result.ok).toBe(false)
    expect(result.error).toContain('outside the TagNest workspace')
  })
})
