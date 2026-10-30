import { describe, expect, it } from 'vitest'
import { checkpointOverlayName, validCheckpoint } from './checkpoint'

describe('checkpointOverlayName', () => {
  it('creates a safe, sortable file name', () => {
    expect(checkpointOverlayName(new Date('2026-10-30T04:22:43.123Z'))).toBe(
      'restore-2026-10-30T04-22-43.qcow2'
    )
  })
})

describe('validCheckpoint', () => {
  const meta = { overlay: 'C:\\data\\restore.qcow2', parent: 'C:\\data\\workspace.qcow2', createdAt: 123 }

  it('accepts metadata whose overlay exists', () => {
    expect(validCheckpoint(meta, () => true)).toEqual(meta)
  })

  it('rejects metadata whose overlay is gone', () => {
    expect(validCheckpoint(meta, () => false)).toBeNull()
  })

  it('rejects malformed or incomplete metadata', () => {
    expect(validCheckpoint(null, () => true)).toBeNull()
    expect(validCheckpoint({}, () => true)).toBeNull()
    expect(validCheckpoint({ overlay: 'x', parent: 'y' }, () => true)).toBeNull()
    expect(validCheckpoint({ overlay: '', parent: 'y', createdAt: 1 }, () => true)).toBeNull()
    expect(validCheckpoint({ overlay: 'x', parent: 'y', createdAt: Number.NaN }, () => true)).toBeNull()
  })
})
