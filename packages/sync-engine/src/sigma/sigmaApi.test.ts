import { describe, it, expect } from 'vitest'
import { normalizeSigmaTimestampToIso, parseCsvObjects } from './sigmaApi'

describe('sigmaApi helpers', () => {
  describe('parseCsvObjects', () => {
    it('parses CSV with quoted fields and embedded commas', () => {
      const csv = [
        'event_timestamp,foo,bar',
        '"2025-04-01 12:34:56.789",a,"b,c"',
        '"2025-04-01 12:34:57.000","x""y",z',
      ].join('\n')

      const rows = parseCsvObjects(csv)
      expect(rows).toHaveLength(2)
      expect(rows[0]).toEqual({
        event_timestamp: '2025-04-01 12:34:56.789',
        foo: 'a',
        bar: 'b,c',
      })
      expect(rows[1]).toEqual({
        event_timestamp: '2025-04-01 12:34:57.000',
        foo: 'x"y',
        bar: 'z',
      })
    })

    it('treats empty fields as null', () => {
      const csv = ['a,b', '1,', ',2'].join('\n')
      const rows = parseCsvObjects(csv)
      expect(rows).toEqual([
        { a: '1', b: null },
        { a: null, b: '2' },
      ])
    })
  })

  describe('normalizeSigmaTimestampToIso', () => {
    it('normalizes "YYYY-MM-DD HH:MM:SS" as UTC', () => {
      expect(normalizeSigmaTimestampToIso('2025-04-01 12:34:56')).toBe('2025-04-01T12:34:56.000Z')
    })

    it('passes through ISO timestamps with timezone', () => {
      expect(normalizeSigmaTimestampToIso('2025-04-01T12:34:56Z')).toBe('2025-04-01T12:34:56.000Z')
    })

    it('returns null for empty/invalid timestamps', () => {
      expect(normalizeSigmaTimestampToIso('')).toBeNull()
      expect(normalizeSigmaTimestampToIso('not-a-timestamp')).toBeNull()
    })
  })
})
