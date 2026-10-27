import { posix } from 'node:path'
import { GUEST_WORKSPACE } from '../linux/guest'

export interface WorkspacePathResult {
  ok: boolean
  path: string
  error?: string
}

/**
 * File tools are deliberately confined to the guest workspace. The agent can
 * still run terminal commands anywhere inside the VM, but every read/write that
 * goes through the structured file tools must stay in this directory.
 */
export function resolveWorkspacePath(input: string): WorkspacePathResult {
  if (!input || !input.trim()) {
    return { ok: false, path: GUEST_WORKSPACE, error: 'A path is required.' }
  }
  if (input.includes('\0')) {
    return { ok: false, path: GUEST_WORKSPACE, error: 'Invalid path.' }
  }
  const normalized = posix.normalize(input.trim())
  const absolute = normalized.startsWith('/') ? normalized : posix.join(GUEST_WORKSPACE, normalized)
  const relative = posix.relative(GUEST_WORKSPACE, absolute)
  if (relative.startsWith('..') || relative === '..' || absolute === '/' || absolute.includes('/../')) {
    return {
      ok: false,
      path: GUEST_WORKSPACE,
      error: `Access denied: ${input} is outside the TagNest workspace (${GUEST_WORKSPACE}).`
    }
  }
  return { ok: true, path: absolute }
}

export function isWithinWorkspace(path: string): boolean {
  return resolveWorkspacePath(path).ok
}
