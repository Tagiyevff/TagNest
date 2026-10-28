import { dialog, type BrowserWindow } from 'electron'
import { lstat, readdir, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, posix } from 'node:path'
import type {
  WorkspaceDownloadResult,
  WorkspaceEntry,
  WorkspaceListing,
  WorkspaceTransfer,
  WorkspaceUploadFile
} from '../../shared/types'
import { resolveWorkspacePath } from '../agent/workspace'
import { GUEST_WORKSPACE } from '../linux/guest'
import { shellQuote, type GuestClient } from '../linux/ssh'
import { logger } from '../logger'

const MAX_LIST_ENTRIES = 500
const MAX_DROP_BYTES = 64 * 1024 * 1024
const MAX_DROP_FILES = 200
const MAX_HOST_BYTES = 512 * 1024 * 1024
const MAX_HOST_FILES = 500
const MAX_DOWNLOAD_BYTES = 512 * 1024 * 1024
const MAX_SINGLE_FILE_BYTES = 256 * 1024 * 1024

interface HostFile {
  local: string
  relative: string
  size: number
}

function emptyTransfer(canceled = false): WorkspaceTransfer {
  return { uploaded: 0, skipped: 0, bytes: 0, files: [], canceled: canceled || undefined }
}

/**
 * Rejects absolute paths, traversal and empty segments before anything reaches
 * the guest. Both the drag & drop path and the local-folder upload path go
 * through this, so `..` can never create a file outside the workspace.
 */
export function sanitizeUploadPath(input: string): string | null {
  const normalized = input.replaceAll('\\', '/').replace(/^\.?\//, '')
  if (!normalized || normalized.length > 900 || normalized.includes('\0')) return null
  const segments = normalized.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return null
  return segments.join('/')
}

function withSuffix(path: string, attempt: number): string {
  const slash = path.lastIndexOf('/')
  const directory = slash === -1 ? '' : path.slice(0, slash + 1)
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const extension = dot > 0 ? name.slice(dot) : ''
  return `${directory}${stem}-${attempt}${extension}`
}

/** Never overwrite a workspace file silently: pick the first free name. */
async function uniqueRemotePath(guest: GuestClient, desired: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? desired : withSuffix(desired, attempt)
    const existing = await guest.stat(candidate)
    if (!existing) return candidate
  }
  throw new Error('Too many files with the same name in the workspace.')
}

async function ensureRemoteDirs(guest: GuestClient, directories: Set<string>): Promise<void> {
  const list = Array.from(directories).filter(Boolean)
  for (let index = 0; index < list.length; index += 20) {
    const chunk = list.slice(index, index + 20)
    const result = await guest.exec(`mkdir -p ${chunk.map((directory) => shellQuote(directory)).join(' ')}`, {
      timeoutMs: 30_000
    })
    if (result.exitCode !== 0) {
      throw new Error(`Could not create the destination folder in Linux: ${result.stderr.trim() || 'mkdir failed'}`)
    }
  }
}

/**
 * Resolves an agent-facing workspace path and checks the real path inside the
 * guest, so a symlink in the workspace cannot redirect the file browser or a
 * download to `/etc` or another user's files.
 */
async function resolveInsideWorkspace(
  guest: GuestClient,
  input: string
): Promise<{ real: string; relative: string }> {
  const resolved = resolveWorkspacePath(input)
  if (!resolved.ok) throw new Error(resolved.error ?? 'Invalid workspace path.')
  let real: string
  try {
    real = await guest.realpath(resolved.path)
  } catch (error) {
    throw new Error(`Cannot open ${resolved.path} in Linux: ${error instanceof Error ? error.message : String(error)}`)
  }
  const relative = posix.relative(GUEST_WORKSPACE, real)
  if (relative === '..' || relative.startsWith('../') || posix.isAbsolute(relative)) {
    throw new Error(`${resolved.path} resolves outside the TagNest workspace and cannot be opened here.`)
  }
  return { real, relative }
}

export async function listWorkspace(guest: GuestClient, input?: string): Promise<WorkspaceListing> {
  const target = input?.trim() ? input : GUEST_WORKSPACE
  const { real, relative } = await resolveInsideWorkspace(guest, target)
  const entries = await guest.list(real)
  const mapped: WorkspaceEntry[] = entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .map((entry) => ({
      name: entry.name,
      path: posix.join(real, entry.name),
      relative: relative ? posix.join(relative, entry.name) : entry.name,
      type: entry.type,
      size: entry.size,
      modified: entry.modified
    }))
    .sort((left, right) => {
      if (left.type === 'directory' && right.type !== 'directory') return -1
      if (right.type === 'directory' && left.type !== 'directory') return 1
      return left.name.localeCompare(right.name)
    })

  return {
    path: real,
    relative,
    parent: relative ? posix.dirname(real) : null,
    entries: mapped.slice(0, MAX_LIST_ENTRIES),
    truncated: mapped.length > MAX_LIST_ENTRIES
  }
}

async function collectHostDirectory(
  root: string,
  prefix: string,
  output: HostFile[],
  limits: { files: number; bytes: number }
): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    // Do not follow host symlinks: a dropped folder must not pull in files
    // from elsewhere on the computer by accident.
    if (entry.isSymbolicLink()) continue
    const full = join(root, entry.name)
    const relative = prefix ? posix.join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) {
      await collectHostDirectory(full, relative, output, limits)
      continue
    }
    if (!entry.isFile()) continue
    const info = await stat(full)
    if (info.size > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`${entry.name} is larger than ${Math.round(MAX_SINGLE_FILE_BYTES / 1024 / 1024)} MB.`)
    }
    limits.files += 1
    limits.bytes += info.size
    if (limits.files > MAX_HOST_FILES) {
      throw new Error(`Too many files: the limit for one copy is ${MAX_HOST_FILES}.`)
    }
    if (limits.bytes > MAX_HOST_BYTES) {
      throw new Error(`Too much data: the limit for one copy is ${Math.round(MAX_HOST_BYTES / 1024 / 1024)} MB.`)
    }
    output.push({ local: full, relative, size: info.size })
  }
}

async function collectHostRoot(
  input: string,
  output: HostFile[],
  limits: { files: number; bytes: number }
): Promise<void> {
  if (!input || !isAbsolute(input)) throw new Error(`Not an absolute host path: ${input}`)
  const info = await lstat(input)
  if (info.isSymbolicLink()) {
    const target = await realpath(input)
    const targetInfo = await stat(target)
    if (targetInfo.isFile()) {
      limits.files += 1
      limits.bytes += targetInfo.size
      if (limits.bytes > MAX_HOST_BYTES) throw new Error('Too much data for one copy.')
      output.push({ local: target, relative: basename(target), size: targetInfo.size })
      return
    }
    throw new Error(`Symlinked folders are not copied: ${basename(input)}`)
  }
  if (info.isFile()) {
    limits.files += 1
    limits.bytes += info.size
    if (info.size > MAX_SINGLE_FILE_BYTES) throw new Error(`${basename(input)} is too large to copy.`)
    if (limits.bytes > MAX_HOST_BYTES) throw new Error('Too much data for one copy.')
    output.push({ local: input, relative: basename(input), size: info.size })
    return
  }
  if (info.isDirectory()) {
    await collectHostDirectory(input, basename(input), output, limits)
    return
  }
  throw new Error(`Only regular files and folders can be copied: ${basename(input)}`)
}

async function writeHostFiles(guest: GuestClient, files: HostFile[], totalBytes: number): Promise<WorkspaceTransfer> {
  const transfer: WorkspaceTransfer = { uploaded: 0, skipped: 0, bytes: 0, files: [] }
  const directories = new Set<string>()
  for (const file of files) {
    const safe = sanitizeUploadPath(file.relative)
    if (safe) directories.add(posix.join(GUEST_WORKSPACE, posix.dirname(safe)))
  }
  await ensureRemoteDirs(guest, directories)

  for (const file of files) {
    const safe = sanitizeUploadPath(file.relative)
    if (!safe) {
      transfer.skipped += 1
      transfer.files.push({ name: file.relative, ok: false, error: 'Unsafe file name.' })
      continue
    }
    try {
      const remote = await uniqueRemotePath(guest, posix.join(GUEST_WORKSPACE, safe))
      await guest.uploadFile(file.local, remote)
      transfer.uploaded += 1
      transfer.bytes += file.size
      transfer.files.push({ name: file.relative, ok: true, path: remote })
    } catch (error) {
      transfer.skipped += 1
      transfer.files.push({
        name: file.relative,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
      logger.warn('files', `upload failed for ${file.relative}`, error)
    }
  }
  logger.info('files', `copied ${transfer.uploaded} file(s) into the guest (${transfer.bytes}/${totalBytes} bytes)`)
  return transfer
}

/** Copies host paths (chosen in a dialog, or dropped) into the workspace. */
export async function uploadHostPaths(guest: GuestClient, hostPaths: string[]): Promise<WorkspaceTransfer> {
  const files: HostFile[] = []
  const limits = { files: 0, bytes: 0 }
  for (const input of hostPaths.slice(0, MAX_HOST_FILES)) {
    await collectHostRoot(input, files, limits)
  }
  if (files.length === 0) {
    return { ...emptyTransfer(), skipped: 1, files: [{ name: '', ok: false, error: 'No files to copy.' }] }
  }
  return writeHostFiles(guest, files, limits.bytes)
}

/** Writes files that arrived from the renderer as bytes (drag & drop). */
export async function uploadBuffers(
  guest: GuestClient,
  files: WorkspaceUploadFile[]
): Promise<WorkspaceTransfer> {
  if (files.length === 0) return emptyTransfer()
  if (files.length > MAX_DROP_FILES) {
    throw new Error(`Too many files: drop at most ${MAX_DROP_FILES} at once.`)
  }
  let total = 0
  for (const file of files) {
    total += file.data.byteLength
    if (file.data.byteLength > MAX_SINGLE_FILE_BYTES) {
      throw new Error(`${file.name} is too large. Use the upload button for files over 64 MB.`)
    }
  }
  if (total > MAX_DROP_BYTES) {
    throw new Error(
      `The drop is ${Math.round(total / 1024 / 1024)} MB; the limit is ${Math.round(MAX_DROP_BYTES / 1024 / 1024)} MB. Use the upload button instead.`
    )
  }

  const transfer: WorkspaceTransfer = { uploaded: 0, skipped: 0, bytes: 0, files: [] }
  const directories = new Set<string>()
  const prepared = files.map((file) => {
    const safe = sanitizeUploadPath(file.relativePath || file.name)
    if (safe) directories.add(posix.join(GUEST_WORKSPACE, posix.dirname(safe)))
    return { file, safe }
  })
  await ensureRemoteDirs(guest, directories)

  for (const { file, safe } of prepared) {
    if (!safe) {
      transfer.skipped += 1
      transfer.files.push({ name: file.name, ok: false, error: 'Unsafe file name.' })
      continue
    }
    try {
      const remote = await uniqueRemotePath(guest, posix.join(GUEST_WORKSPACE, safe))
      await guest.writeBuffer(remote, Buffer.from(file.data))
      transfer.uploaded += 1
      transfer.bytes += file.data.byteLength
      transfer.files.push({ name: file.name, ok: true, path: remote })
    } catch (error) {
      transfer.skipped += 1
      transfer.files.push({
        name: file.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }
  return transfer
}

export async function pickAndUploadFiles(guest: GuestClient, window: BrowserWindow): Promise<WorkspaceTransfer> {
  const picked = await dialog.showOpenDialog(window, {
    title: 'Copy files into the TagNest Linux workspace',
    buttonLabel: 'Copy into Linux',
    properties: ['openFile', 'multiSelections']
  })
  if (picked.canceled || picked.filePaths.length === 0) return emptyTransfer(true)
  return uploadHostPaths(guest, picked.filePaths)
}

export async function downloadWorkspaceFile(
  guest: GuestClient,
  input: string,
  window: BrowserWindow
): Promise<WorkspaceDownloadResult> {
  try {
    const { real } = await resolveInsideWorkspace(guest, input)
    const entry = await guest.stat(real)
    if (!entry) return { ok: false, error: 'That file no longer exists in Linux.' }
    if (entry.type === 'directory') {
      return { ok: false, error: 'Folders cannot be downloaded from the file list; choose a file.' }
    }
    if (entry.size > MAX_DOWNLOAD_BYTES) {
      return { ok: false, error: 'That file is larger than the 512 MB download limit.' }
    }
    const target = await dialog.showSaveDialog(window, {
      title: 'Save a file from the TagNest Linux workspace',
      defaultPath: basename(real)
    })
    if (target.canceled || !target.filePath) return { ok: false, canceled: true }
    await guest.downloadFile(real, target.filePath)
    logger.info('files', `downloaded a guest file to ${target.filePath}`)
    return { ok: true, path: target.filePath }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
