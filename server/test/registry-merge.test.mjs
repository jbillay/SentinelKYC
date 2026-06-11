import { describe, it, expect } from 'vitest'
import { mergeEnrichment, composeRecord, isMissing } from '../services/registry/merge.js'
import mockVendor from '../services/registry/providers/mock.js'

describe('isMissing', () => {
  it('treats null/undefined/blank/empty-array as missing', () => {
    expect(isMissing(null)).toBe(true)
    expect(isMissing(undefined)).toBe(true)
    expect(isMissing('  ')).toBe(true)
    expect(isMissing([])).toBe(true)
  })
  it('treats real values as present', () => {
    expect(isMissing(0)).toBe(false)
    expect(isMissing(false)).toBe(false)
    expect(isMissing('x')).toBe(false)
    expect(isMissing(['a'])).toBe(false)
    expect(isMissing({})).toBe(false)
  })
})

describe('mergeEnrichment', () => {
  const base = { company_name: 'ACME LTD', sic_codes: [], jurisdiction: null }

  it('fills only missing fields and attributes them', () => {
    const { merged, attribution } = mergeEnrichment(
      base,
      { company_name: 'WRONG NAME', sic_codes: ['64999'], jurisdiction: 'england-wales', extra_block: { a: 1 } },
      'mock'
    )
    expect(merged.company_name).toBe('ACME LTD') // base wins
    expect(merged.sic_codes).toEqual(['64999']) // empty array counts as gap
    expect(merged.jurisdiction).toBe('england-wales')
    expect(merged.extra_block).toEqual({ a: 1 })
    expect(attribution).toEqual({ sic_codes: 'mock', jurisdiction: 'mock', extra_block: 'mock' })
  })

  it('does not mutate inputs', () => {
    const frozenBase = Object.freeze({ a: 1 })
    const { merged } = mergeEnrichment(frozenBase, { b: 2 }, 'v')
    expect(merged).toEqual({ a: 1, b: 2 })
    expect(frozenBase).toEqual({ a: 1 })
  })

  it('earlier enricher wins over a later one (ordered chain)', () => {
    const first = mergeEnrichment({ x: null }, { x: 'from-v1' }, 'v1')
    const second = mergeEnrichment(first.merged, { x: 'from-v2' }, 'v2', first.attribution)
    expect(second.merged.x).toBe('from-v1')
    expect(second.attribution.x).toBe('v1')
  })
})

describe('composeRecord', () => {
  it('returns the base untouched when no enricher contributes', () => {
    const base = { company_name: 'ACME LTD', sic_codes: ['11111'] }
    const out = composeRecord(base, [{ vendorId: 'mock', data: { sic_codes: ['64999'] } }])
    expect(out).toBe(base) // same reference — zero behavioral change for CH-only paths
    expect(out._vendorAttribution).toBeUndefined()
  })

  it('attaches _vendorAttribution only when fields were contributed', () => {
    const base = { company_name: 'ACME LTD' }
    const out = composeRecord(base, [{ vendorId: 'mock', data: { vendor_enrichment: { score: 1 } } }])
    expect(out._vendorAttribution).toEqual({ vendor_enrichment: 'mock' })
  })

  it('passes a null base through (company not found)', () => {
    expect(composeRecord(null, [{ vendorId: 'mock', data: { a: 1 } }])).toBe(null)
  })

  it('skips null enrichment results (vendor outage is best-effort)', () => {
    const base = { a: 1 }
    expect(composeRecord(base, [{ vendorId: 'down', data: null }])).toBe(base)
  })
})

describe('mock vendor', () => {
  it('declares the enrich role and profile capability only', () => {
    expect(mockVendor.role).toBe('enrich')
    expect(mockVendor.capabilities.profile).toBe(true)
    expect(mockVendor.capabilities.documents).toBeUndefined()
  })

  it('returns a deterministic profile enrichment', async () => {
    const e1 = await mockVendor.enrichProfile('12345678', {})
    const e2 = await mockVendor.enrichProfile('12345678', {})
    expect(e1).toEqual(e2)
    expect(e1.vendor_enrichment.provider).toBe('mock')
  })
})
