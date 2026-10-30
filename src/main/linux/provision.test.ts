import { describe, expect, it } from 'vitest'
import { contentRangeTotal } from './provision'

describe('contentRangeTotal', () => {
  it('reads the total size from a range response', () => {
    expect(contentRangeTotal('bytes 123-456/789')).toBe(789)
    expect(contentRangeTotal('bytes 0-1/157810688')).toBe(157810688)
  })

  it('handles whitespace and a range that ends at the last byte', () => {
    expect(contentRangeTotal('bytes 100-157810687/157810688')).toBe(157810688)
    expect(contentRangeTotal('bytes 0-0/ 42')).toBe(42)
  })

  it('returns null for unknown or malformed totals', () => {
    expect(contentRangeTotal(null)).toBeNull()
    expect(contentRangeTotal('bytes 0-0/*')).toBeNull()
    expect(contentRangeTotal('bytes 0-0/abc')).toBeNull()
    expect(contentRangeTotal('bytes 0-0/0')).toBeNull()
    expect(contentRangeTotal('garbage')).toBeNull()
  })
})
