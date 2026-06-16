import { describe, it, expect } from 'vitest'
import { formatRationale, RationaleSchema } from '../services/risk/rationale.js'
import {
  normName,
  isCorporatePsc,
  isCeasedPsc,
  tierScore,
  longestPrefixMatch,
  computeGeographic,
  computeEntityType,
  computeStructuralComplexity,
  computeIndustry,
} from '../services/risk/factors.js'
import { normKey, normalizeCountry, normalizeEntityType, normalizeSicCodes } from '../services/risk/normalize.js'

// ---------------------------------------------------------------------------
// rationale.formatRationale — pure formatter, no LLM
// ---------------------------------------------------------------------------
describe('formatRationale', () => {
  const receipt = { tier: 'Medium', score: 42 }

  it('assembles tier + score + headline + drivers + sanctionsNote', () => {
    const out = formatRationale(receipt, {
      headline: 'Elevated structural complexity.',
      drivers: [
        { factor: 'structuralComplexity', reason: 'three corporate layers' },
        { factor: 'geographic', reason: 'offshore registration' },
      ],
      sanctionsNote: 'No sanctions match.',
    })
    expect(out).toBe(
      'Entity assessed as Medium (Score: 42). Elevated structural complexity. ' +
        'Primary drivers: three corporate layers; offshore registration. No sanctions match.'
    )
  })

  it('omits the driver clause when there are no drivers', () => {
    const out = formatRationale(receipt, { headline: 'Clean.', drivers: [], sanctionsNote: null })
    expect(out).toBe('Entity assessed as Medium (Score: 42). Clean.')
  })

  it('caps drivers at three and drops blank reasons', () => {
    const out = formatRationale(receipt, {
      headline: '',
      drivers: [
        { factor: 'a', reason: 'one' },
        { factor: 'b', reason: '  ' },
        { factor: 'c', reason: 'two' },
        { factor: 'd', reason: 'three' },
        { factor: 'e', reason: 'four' },
      ],
      sanctionsNote: '',
    })
    // blank dropped, then sliced to 3 → one, two, three
    expect(out).toContain('Primary drivers: one; two; three.')
    expect(out).not.toContain('four')
  })

  it('falls back to Unknown tier and ? score when the receipt is empty', () => {
    expect(formatRationale(null, null)).toBe('Entity assessed as Unknown (Score: ?).')
    expect(formatRationale({}, {})).toBe('Entity assessed as Unknown (Score: ?).')
  })

  it('RationaleSchema accepts a minimal object and applies defaults', () => {
    const parsed = RationaleSchema.parse({ headline: 'hi' })
    expect(parsed.drivers).toEqual([])
    expect(parsed.sanctionsNote).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// factors.js small pure helpers + label fallbacks
// ---------------------------------------------------------------------------
describe('factors helper predicates', () => {
  it('normName upper-cases, trims, collapses whitespace, tolerates nullish', () => {
    expect(normName('  Acme   Holdings ')).toBe('ACME HOLDINGS')
    expect(normName(null)).toBe('')
    expect(normName(undefined)).toBe('')
  })

  it('isCorporatePsc recognises corporate / legal-person / legal-entity kinds', () => {
    expect(isCorporatePsc({ kind: 'corporate-entity-person-with-significant-control' })).toBe(true)
    expect(isCorporatePsc({ kind: 'legal-person-person-with-significant-control' })).toBe(true)
    expect(isCorporatePsc({ kind: 'legal-entity' })).toBe(true)
    expect(isCorporatePsc({ kind: 'individual-person-with-significant-control' })).toBe(false)
    expect(isCorporatePsc(null)).toBe(false)
  })

  it('isCeasedPsc reads ceased_on or ceased', () => {
    expect(isCeasedPsc({ ceased_on: '2020-01-01' })).toBe(true)
    expect(isCeasedPsc({ ceased: true })).toBe(true)
    expect(isCeasedPsc({})).toBe(false)
    expect(isCeasedPsc(null)).toBe(false)
  })

  it('tierScore returns 0 for empty/missing tiers and clamps past the last tier', () => {
    expect(tierScore(null, 5)).toBe(0)
    expect(tierScore([], 5)).toBe(0)
    expect(tierScore([{ upTo: 1, score: 10 }], 99)).toBe(10) // no open-ended tier → last tier score
  })

  it('longestPrefixMatch skips empty/non-string prefixes', () => {
    expect(longestPrefixMatch([{ prefix: '', score: 1 }, { prefix: 64, score: 2 }], '64999')).toBe(null)
    expect(longestPrefixMatch(undefined, '64999')).toBe(null)
  })
})

const MATRIX = {
  weights: { geographic: 0.4, entityType: 0.2, structuralComplexity: 0.25, industry: 0.15 },
  factors: {
    geographic: { default: 50, scores: { GB: 10 } },
    entityType: { default: 40, scores: { ltd: 10 } },
    structuralComplexity: {
      combineRule: 'max',
      corporatePscCount: { tiers: [{ upTo: 0, score: 0 }, { upTo: null, score: 80 }] },
      shareholderLayers: { tiers: [{ upTo: 1, score: 0 }, { upTo: null, score: 90 }] },
    },
    industry: { combineRule: 'max', default: 30, prefixes: [{ prefix: '64', score: 70 }] },
  },
}

describe('factors — label fallbacks and zero-weight matrices', () => {
  it('uses the default labels when the matrix supplies none', () => {
    expect(computeGeographic({}, MATRIX, { iso2: null, source: 'unknown' }).label).toBe('Geographic risk')
    expect(computeEntityType({}, MATRIX).label).toBe('Entity type')
    expect(computeStructuralComplexity({}, { items: [] }, {}, MATRIX).label).toBe('Structural complexity')
    expect(computeIndustry({}, MATRIX, []).label).toBe('Industry risk')
  })

  it('uses a configured factor label when present', () => {
    const m = { ...MATRIX, factors: { ...MATRIX.factors, geographic: { ...MATRIX.factors.geographic, label: 'Geo' } } }
    expect(computeGeographic({}, m, { iso2: 'GB', source: 'lookup' }).label).toBe('Geo')
  })

  it('zero weight everywhere (empty matrix) yields zero contributions and default base scores', () => {
    const fGeo = computeGeographic({}, {}, { iso2: null })
    expect(fGeo.weight).toBe(0)
    expect(fGeo.contribution).toBe(0)
    const fEnt = computeEntityType({}, {})
    expect(fEnt.weight).toBe(0)
    const fStruct = computeStructuralComplexity({}, null, null, {})
    expect(fStruct.attribute.combineRule).toBe('max') // default combineRule
    const fInd = computeIndustry({}, {}, ['64999'])
    expect(fInd.weight).toBe(0)
  })

  it('geographic falls back to the profile evidence path when nothing resolves', () => {
    const f = computeGeographic({}, MATRIX, { iso2: null, source: 'unknown' })
    expect(f.evidence.path).toBe('profile.registered_office_address.country')
    expect(f.attribute.matched).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalize.js — pure / no-I/O branches (no LLM, no cache)
// ---------------------------------------------------------------------------
describe('normalize.normKey', () => {
  it('normKey lowercases, trims, collapses, tolerates null/undefined', () => {
    expect(normKey('  United   Kingdom ')).toBe('united kingdom')
    expect(normKey(null)).toBe('')
    expect(normKey(undefined)).toBe('')
    expect(normKey(123)).toBe('123')
  })
})

describe('normalizeCountry — lookup + unknown (no LLM)', () => {
  it('resolves a known country from the static lookup without I/O', async () => {
    const r = await normalizeCountry('United Kingdom')
    expect(r.iso2).toBe('GB')
    expect(r.source).toBe('lookup')
    expect(r.label).toBe('United Kingdom')
  })

  it('returns unknown for an empty country without touching the cache or LLM', async () => {
    const r = await normalizeCountry('')
    expect(r).toEqual({ iso2: null, label: null, source: 'unknown' })
    const r2 = await normalizeCountry(null)
    expect(r2.source).toBe('unknown')
  })
})

describe('normalizeEntityType / normalizeSicCodes', () => {
  it('maps aliases, passes slugs through, returns null for empty', () => {
    expect(normalizeEntityType('Private Limited Company')).toBe('ltd')
    expect(normalizeEntityType('Limited Liability Partnership')).toBe('llp')
    expect(normalizeEntityType('private-limited-guarant-nsc')).toBe('private-limited-guarant-nsc')
    expect(normalizeEntityType('')).toBe(null)
    expect(normalizeEntityType(null)).toBe(null)
  })

  it('coerces, trims, and filters SIC codes; tolerates non-arrays', () => {
    expect(normalizeSicCodes({ sic_codes: [' 64999 ', '', null, 12345] })).toEqual(['64999', '12345'])
    expect(normalizeSicCodes({})).toEqual([])
    expect(normalizeSicCodes(null)).toEqual([])
    expect(normalizeSicCodes({ sic_codes: 'not-array' })).toEqual([])
  })
})
