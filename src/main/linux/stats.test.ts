import { describe, expect, it } from 'vitest'
import { parseGuestStats } from './stats'

const SAMPLE = `@@MEM
3072 1450
@@DISK
20480 5120
@@LOAD
0.42
@@CPU
2
@@UP
1234
`

describe('parseGuestStats', () => {
  it('parses the marker format from the guest', () => {
    const stats = parseGuestStats(SAMPLE)
    expect(stats).not.toBeNull()
    expect(stats?.memoryTotalMB).toBe(3072)
    expect(stats?.memoryUsedMB).toBe(1450)
    expect(stats?.diskTotalGB).toBe(20)
    expect(stats?.diskUsedGB).toBeCloseTo(5, 5)
    expect(stats?.load1).toBeCloseTo(0.42, 5)
    expect(stats?.cpus).toBe(2)
    expect(stats?.uptimeSeconds).toBe(1234)
  })

  it('uses zero for a missing load or uptime instead of inventing values', () => {
    const stats = parseGuestStats('@@MEM\n2048 700\n@@DISK\n10240 1024\n@@CPU\n1\n')
    expect(stats?.load1).toBe(0)
    expect(stats?.uptimeSeconds).toBe(0)
  })

  it('returns null when the guest answer is unusable', () => {
    expect(parseGuestStats('')).toBeNull()
    expect(parseGuestStats('free: not found')).toBeNull()
    expect(parseGuestStats('@@MEM\n0 0\n@@DISK\n2048 10\n@@CPU\n1\n')).toBeNull()
    expect(parseGuestStats('@@MEM\n2048 700\n@@DISK\n0 0\n@@CPU\n1\n')).toBeNull()
  })

  it('clamps impossible memory readings into the reported total', () => {
    const stats = parseGuestStats('@@MEM\n1024 5000\n@@DISK\n10240 1024\n@@CPU\n2\n')
    expect(stats?.memoryUsedMB).toBe(1024)
  })
})
