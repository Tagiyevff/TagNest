import type { RuntimeState, SettingsView } from '../shared/types'
import { redactSecrets } from './redact'

export interface DiagnosticsLogs {
  app: string
  serial: string
  qemu: string
}

export interface DiagnosticsDisk {
  baseImageBytes?: number
  workspaceBytes?: number
}

export interface DiagnosticsInput {
  version: string
  platform: string
  arch: string
  electron: string
  node: string
  settings: SettingsView
  runtime: RuntimeState
  secrets: Record<string, boolean>
  logs: DiagnosticsLogs
  disk?: DiagnosticsDisk
  generatedAt?: Date
  /** Absolute paths (home, data directory) that must not appear verbatim. */
  redactions?: string[]
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/**
 * A single, shareable text report for support. It deliberately excludes API
 * keys, the VNC token and absolute user paths; log tails go through the same
 * secret redaction the logger uses.
 */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const generatedAt = input.generatedAt ?? new Date()
  const redactions = [...(input.redactions ?? [])].filter((value) => value.length > 1)
  const scrub = (text: string): string => {
    let out = redactSecrets(text)
    for (const value of redactions) {
      // JSON sections escape backslashes, so replace the escaped form too.
      const escaped = value.replace(/\\/g, '\\\\')
      out = out.split(escaped).join('<path>').split(value).join('<path>')
    }
    return out
  }

  const settings = {
    provider: input.settings.provider,
    model: input.settings.model,
    modelMode: input.settings.modelMode,
    baseUrl: input.settings.baseUrl ? scrub(input.settings.baseUrl) : '',
    language: input.settings.language,
    memoryMB: input.settings.memoryMB,
    cpus: input.settings.cpus,
    diskGB: input.settings.diskGB,
    autoStartLinux: input.settings.autoStartLinux,
    approveSafeCommands: input.settings.approveSafeCommands
  }

  const runtime = {
    phase: input.runtime.phase,
    message: input.runtime.message,
    detail: input.runtime.detail,
    progress: input.runtime.progress,
    acceleration: input.runtime.acceleration,
    warning: input.runtime.warning,
    error: input.runtime.error,
    qemuFound: input.runtime.qemuFound,
    qemuCanInstall: input.runtime.qemuCanInstall,
    qemuInstalling: input.runtime.qemuInstalling,
    startedAt: input.runtime.startedAt ? new Date(input.runtime.startedAt).toISOString() : undefined,
    memoryMB: input.runtime.memoryMB,
    cpus: input.runtime.cpus,
    checkpoint: input.runtime.checkpoint
  }

  const keys = Object.entries(input.secrets)
    .map(([provider, present]) => `  ${provider}: ${present ? 'stored' : 'missing'}`)
    .join('\n')

  return scrub(
    [
      'TagNest diagnostics',
      '==================',
      `Generated: ${generatedAt.toISOString()}`,
      `Version: ${input.version}`,
      `Platform: ${input.platform} ${input.arch}`,
      `Runtime versions: Electron ${input.electron}, Node ${input.node}`,
      '',
      'Runtime',
      '-------',
      JSON.stringify(runtime, null, 2),
      '',
      'Settings',
      '--------',
      JSON.stringify(settings, null, 2),
      '',
      'Provider credentials (never values)',
      '-----------------------------------',
      keys || '  (none)',
      '',
      'Disk',
      '----',
      `  Base image: ${formatBytes(input.disk?.baseImageBytes)}`,
      `  Workspace overlay: ${formatBytes(input.disk?.workspaceBytes)}`,
      '',
      'Application log (tail)',
      '----------------------',
      input.logs.app.trim() || '(empty)',
      '',
      'Linux serial console (tail)',
      '---------------------------',
      input.logs.serial.trim() || '(empty)',
      '',
      'QEMU stderr (tail)',
      '------------------',
      input.logs.qemu.trim() || '(empty)',
      ''
    ].join('\n')
  )
}
