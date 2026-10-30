import { describe, expect, it } from 'vitest'
import { buildDiagnostics, formatBytes } from './diagnostics'
import type { RuntimeState, SettingsView } from '../shared/types'

const runtime: RuntimeState = {
  phase: 'running',
  message: 'Linux is running',
  acceleration: 'whpx',
  vncUrl: 'ws://127.0.0.1:1234/vnc?token=supersecrettoken',
  qemuFound: true,
  qemuCanInstall: true,
  qemuInstalling: false,
  memoryMB: 3072,
  cpus: 2
}

const settings: SettingsView = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  modelMode: 'manual',
  baseUrl: 'file:///C:\\Users\\Acer\\models/v1?key=sk-proj-abcdefghijklmnopqrstuvwxyz',
  language: 'en',
  memoryMB: 3072,
  cpus: 2,
  diskGB: 20,
  autoStartLinux: true,
  approveSafeCommands: true,
  launchAtLogin: false,
  hasApiKey: true,
  providers: []
}

describe('buildDiagnostics', () => {
  const report = buildDiagnostics({
    version: '0.6.0',
    platform: 'win32',
    arch: 'x64',
    electron: '45.0.0',
    node: '24.0.0',
    settings,
    runtime,
    secrets: { openai: true, gemini: false },
    logs: {
      app: '2026-01-01 INFO using sk-proj-abcdefghijklmnopqrstuvwxyz\nC:\\Users\\Acer\\AppData\\Roaming\\TagNest\\logs',
      serial: 'Booting Linux',
      qemu: ''
    },
    disk: { baseImageBytes: 157810688, workspaceBytes: 2048 },
    redactions: ['C:\\Users\\Acer'],
    generatedAt: new Date('2026-01-01T00:00:00Z')
  })

  it('includes version, runtime and settings', () => {
    expect(report).toContain('Version: 0.6.0')
    expect(report).toContain('"phase": "running"')
    expect(report).toContain('"provider": "openai"')
    expect(report).toContain('openai: stored')
    expect(report).toContain('gemini: missing')
  })

  it('never contains API keys, the VNC token or the home directory', () => {
    expect(report).not.toContain('sk-proj-abcdefghijklmnopqrstuvwxyz')
    expect(report).not.toContain('supersecrettoken')
    expect(report).not.toContain('C:\\Users\\Acer')
    expect(report).not.toContain('Acer')
    expect(report).not.toContain('vncUrl')
    expect(report).toContain('<path>')
  })

  it('redacts secrets inside log tails', () => {
    expect(report).not.toContain('abcdefghijklmnopqrstuvwxyz')
    expect(report).toContain('Booting Linux')
  })
})

describe('formatBytes', () => {
  it('formats sizes for the report', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(157810688)).toBe('150.5 MB')
  })
})
