import { describe, it, expect } from 'vitest'
import { mergeEnrichment, composeRecord, isMissing } from '../services/registry/merge.js'

describe('isMissing — exhaustive', () => {
  it('null / undefined / blank string / empty array are missing', () => {
    expect(isMissing(null)).toBe(true)
    expect(isMissing(undefined)).toBe(true)
    expect(isMissing('')).toBe(true)
    expect(isMissing('   ')).toBe(true)
    expect(isMissing([])).toBe(true)
  })

  it('0, false, non-empty string/array, and {} are present', () => {
    expect(isMissing(0)).toBe(false)
    expect(isMissing(false)).toBe(false)
    expect(isMissing('x')).toBe(false)
    expect(isMissing([null])).toBe(false) // length 1 → present
    expect(isMissing({})).toBe(false)
  })
})

describe('mergeEnrichment', () => {
  it('skips missing enrichment values entirely', () => {
    const { merged, attribution } = mergeEnrichment({ a: 1 }, { b: '', c: null, d: [] }, 'v')
    expect(merged).toEqual({ a: 1 })
    expect(attribution).toEqual({})
  })

  it('fills only gaps and records attribution', () => {
    const { merged, attribution } = mergeEnrichment(
      { name: 'BASE', sic_codes: [] },
      { name: 'OTHER', sic_codes: ['64999'], jurisdiction: 'gb' },
      'orbis'
    )
    expect(merged.name).toBe('BASE') // base wins
    expect(merged.sic_codes).toEqual(['64999']) // empty array was a gap
    expect(merged.jurisdiction).toBe('gb')
    expect(attribution).toEqual({ sic_codes: 'orbis', jurisdiction: 'orbis' })
  })

  it('does not mutate frozen inputs', () => {
    const base = Object.freeze({ a: 1 })
    const enr = Object.freeze({ b: 2 })
    const { merged } = mergeEnrichment(base, enr, 'v')
    expect(merged).toEqual({ a: 1, b: 2 })
    expect(base).toEqual({ a: 1 })
  })

  it('tolerates null base and null enrichment', () => {
    expect(mergeEnrichment(null, { x: 1 }, 'v').merged).toEqual({ x: 1 })
    expect(mergeEnrichment({ x: 1 }, null, 'v').merged).toEqual({ x: 1 })
  })

  it('carries prior attribution forward (earlier enricher wins)', () => {
    const first = mergeEnrichment({ x: null }, { x: 'v1', y: 'v1y' }, 'v1')
    const second = mergeEnrichment(first.merged, { x: 'v2', z: 'v2z' }, 'v2', first.attribution)
    expect(second.merged.x).toBe('v1')
    expect(second.attribution).toEqual({ x: 'v1', y: 'v1', z: 'v2' })
  })
})

describe('composeRecord', () => {
  it('returns the base by reference when nothing is contributed', () => {
    const base = { name: 'X', sic_codes: ['1'] }
    const out = composeRecord(base, [{ vendorId: 'm', data: { name: 'Y', sic_codes: ['2'] } }])
    expect(out).toBe(base)
    expect(out._vendorAttribution).toBeUndefined()
  })

  it('returns base when the enrichment list is empty/omitted', () => {
    const base = { a: 1 }
    expect(composeRecord(base)).toBe(base)
    expect(composeRecord(base, [])).toBe(base)
  })

  it('passes null/undefined base straight through', () => {
    expect(composeRecord(null, [{ vendorId: 'm', data: { a: 1 } }])).toBe(null)
    expect(composeRecord(undefined, [{ vendorId: 'm', data: { a: 1 } }])).toBe(undefined)
  })

  it('skips vendor results with no data (outage tolerance)', () => {
    const base = { a: 1 }
    expect(composeRecord(base, [{ vendorId: 'down', data: null }, { vendorId: 'down2', data: undefined }])).toBe(base)
  })

  it('attaches _vendorAttribution from a multi-vendor chain, earliest wins', () => {
    const base = { name: 'CO', sic_codes: [] }
    const out = composeRecord(base, [
      { vendorId: 'v1', data: { sic_codes: ['111'], extra1: 'a' } },
      { vendorId: 'v2', data: { sic_codes: ['222'], extra2: 'b' } }, // sic_codes already filled by v1
    ])
    expect(out.sic_codes).toEqual(['111'])
    expect(out.extra1).toBe('a')
    expect(out.extra2).toBe('b')
    expect(out._vendorAttribution).toEqual({ sic_codes: 'v1', extra1: 'v1', extra2: 'v2' })
    // base untouched
    expect(base._vendorAttribution).toBeUndefined()
  })
})
