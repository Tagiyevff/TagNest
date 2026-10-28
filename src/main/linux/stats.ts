import type { GuestStats } from '../../shared/types'
import type { GuestClient } from './ssh'

/**
 * One SSH round-trip that prints machine-readable markers followed by the
 * values TagNest shows in the Linux panel. Each value comes from the kernel or
 * from procps inside the guest; nothing is estimated on the host.
 */
export const GUEST_STATS_COMMAND = [
  'echo "@@MEM"',
  'free -m | awk \'/^Mem:/ {print $2" "$3}\'',
  'echo "@@DISK"',
  'df -m / | awk \'NR==2 {print $2" "$3}\'',
  'echo "@@LOAD"',
  'cut -d" " -f1 /proc/loadavg',
  'echo "@@CPU"',
  'nproc',
  'echo "@@UP"',
  'cut -d. -f1 /proc/uptime'
].join('; ')

/**
 * Parses the marker format above. Returns null when the guest did not answer
 * with usable numbers, so the UI can hide the meter instead of showing zeros
 * that look like a real reading.
 */
export function parseGuestStats(raw: string): GuestStats | null {
  const sections = new Map<string, string>()
  let current = ''
  for (const line of raw.split('\n')) {
    const marker = /^@@([A-Z]+)\s*$/.exec(line.trim())
    if (marker) {
      current = marker[1]
      sections.set(current, '')
      continue
    }
    if (current) sections.set(current, `${sections.get(current) ?? ''}${line}\n`)
  }

  const numbers = (name: string): number[] =>
    (sections.get(name) ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((value) => Number(value))

  const [memoryTotalMB, memoryUsedMB] = numbers('MEM')
  const [diskTotalMB, diskUsedMB] = numbers('DISK')
  const [load1] = numbers('LOAD')
  const [cpus] = numbers('CPU')
  const [uptimeSeconds] = numbers('UP')

  if (!Number.isFinite(memoryTotalMB) || memoryTotalMB <= 0) return null
  if (!Number.isFinite(diskTotalMB) || diskTotalMB <= 0) return null
  if (!Number.isFinite(cpus) || cpus <= 0) return null

  return {
    memoryUsedMB: Math.max(0, Math.min(memoryTotalMB, memoryUsedMB || 0)),
    memoryTotalMB,
    diskUsedGB: Math.max(0, (diskUsedMB || 0) / 1024),
    diskTotalGB: diskTotalMB / 1024,
    load1: Number.isFinite(load1) ? load1 : 0,
    cpus,
    uptimeSeconds: Number.isFinite(uptimeSeconds) ? uptimeSeconds : 0
  }
}

export async function readGuestStats(guest: GuestClient): Promise<GuestStats | null> {
  try {
    const result = await guest.exec(GUEST_STATS_COMMAND, { timeoutMs: 15_000 })
    if (result.exitCode !== 0) return null
    return parseGuestStats(result.stdout)
  } catch {
    return null
  }
}
