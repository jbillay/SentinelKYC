import { describe, it, expect } from 'vitest'
import {
  round2,
  tierScore,
  longestPrefixMatch,
  computeGeographic,
  computeEntityType,
  computeStructuralComplexity,
  computeIndustry,
} from '../services/risk/factors.js'
import { normKey, normalizeEntityType, normalizeSicCodes } from '../services/risk/normalize.js'
import { validateMatrix, defaultMatrixBody } from '../services/risk/matrix.js'

const MATRIX = {
  weights: { geographic: 0.4, entityType: 0.2, structuralComplexity: 0.25, industry: 0.15 },
  factors: {
    geographic: { default: 50, scores: { GB: 10, PA: 90 } },
    entityType: { default: 40, scores: { ltd: 10, plc: 15 } },
    structuralComplexity: {
      combineRule: 'max',
      corporatePscCount: { tiers: [{ upTo: 0, score: 0 }, { upTo: 2, score: 40 }, { upTo: null, score: 80 }] },
      shareholderLayers: { tiers: [{ upTo: 1, score: 0 }, { upTo: 3, score: 50 }, { upTo: null, score: 90 }] },
    },
    industry: { combineRule: 'max', default: 30, prefixes: [{ prefix: '64', score: 70 }, { prefix: '6499', score: 95 }] },
  },
}

describe('tierScore / longestPrefixMatch / round2', () => {
  it('selects the first covering tier, open-ended last', () => {
    const tiers = MATRIX.factors.structuralComplexity.corporatePscCount.tiers
    expect(tierScore(tiers, 0)).toBe(0)
    expect(tierScore(tiers, 2)).toBe(40)
    expect(tierScore(tiers, 7)).toBe(80)
    expect(tierScore([], 5)).toBe(0)
  })

  it('prefers the longest matching SIC prefix', () => {
    expect(longestPrefixMatch(MATRIX.factors.industry.prefixes, '64999').prefix).toBe('6499')
    expect(longestPrefixMatch(MATRIX.factors.industry.prefixes, '64100').prefix).toBe('64')
    expect(longestPrefixMatch(MATRIX.factors.industry.prefixes, '11111')).toBe(null)
  })

  it('round2 rounds to 2 decimals', () => {
    expect(round2(0.4 * 33.333)).toBe(13.33)
  })
})

describe('computeGeographic', () => {
  const profile = { registered_office_address: { country: 'United Kingdom' } }

  it('scores a matched ISO2 and records the evidence path', () => {
    const f = computeGeographic(profile, MATRIX, { iso2: 'GB', source: 'lookup' })
    expect(f.baseScore).toBe(10)
    expect(f.contribution).toBe(4) // 0.4 × 10
    expect(f.attribute.matched).toBe(true)
    expect(f.evidence.path).toBe('profile.registered_office_address.country')
  })

  it('falls back to the default on an unmatched country', () => {
    const f = computeGeographic(profile, MATRIX, { iso2: null, source: 'unknown' })
    expect(f.baseScore).toBe(50)
    expect(f.attribute.matched).toBe(false)
  })

  it('uses the kycCard country when the profile has none', () => {
    const f = computeGeographic({}, MATRIX, { iso2: 'PA', source: 'lookup' }, {
      kycCard: { identity: { countryOfIncorporation: 'Panama' } },
    })
    expect(f.baseScore).toBe(90)
    expect(f.evidence.path).toBe('kycCard.identity.countryOfIncorporation')
  })
})

describe('computeEntityType', () => {
  it('matches CH slugs and human-readable aliases', () => {
    expect(computeEntityType({ type: 'ltd' }, MATRIX).baseScore).toBe(10)
    expect(computeEntityType({ type: 'Public Limited Company' }, MATRIX).baseScore).toBe(15)
    expect(computeEntityType({ type: 'something-weird' }, MATRIX).baseScore).toBe(40)
  })
})

describe('computeStructuralComplexity', () => {
  it('combines corporate-PSC count and layer heuristic by max', () => {
    const psc = { items: [
      { name: 'HOLDCO LTD', kind: 'corporate-entity-person-with-significant-control' },
      { name: 'CEASED CORP', kind: 'corporate-entity-person-with-significant-control', ceased_on: '2020-01-01' },
      { name: 'Jane Doe', kind: 'individual-person-with-significant-control' },
    ] }
    const kycCard = { shareholders: [
      { name: 'HOLDCO LTD', type: 'corporate' }, // already a PSC — not double counted
      { name: 'NESTED HOLDINGS LTD', type: 'corporate' },
      { name: 'John Smith', type: 'individual' },
    ] }
    const f = computeStructuralComplexity({}, psc, kycCard, MATRIX)
    expect(f.attribute.corporatePscCount).toBe(1)
    expect(f.attribute.shareholderLayers).toBe(3) // 1 + 1 PSC + 1 nested corp
    expect(f.baseScore).toBe(50) // max(40 @count1, 50 @layers3)
    expect(f.contribution).toBe(12.5)
  })

  it('scores a simple company zero', () => {
    const f = computeStructuralComplexity({}, { items: [] }, { shareholders: [] }, MATRIX)
    expect(f.baseScore).toBe(0)
  })
})

describe('computeIndustry', () => {
  it('takes the highest-scoring longest-prefix match across all codes', () => {
    const f = computeIndustry({}, MATRIX, ['11111', '64999'])
    expect(f.baseScore).toBe(95)
    expect(f.attribute.prefix).toBe('6499')
  })

  it('falls back to default with no matching code', () => {
    expect(computeIndustry({}, MATRIX, ['11111']).baseScore).toBe(30)
    expect(computeIndustry({}, MATRIX, []).baseScore).toBe(30)
  })
})

describe('risk normalize helpers', () => {
  it('normKey lowercases and collapses whitespace', () => {
    expect(normKey('  United   Kingdom ')).toBe('united kingdom')
  })

  it('normalizeEntityType maps aliases and passes slugs through', () => {
    expect(normalizeEntityType('Private Limited Company')).toBe('ltd')
    expect(normalizeEntityType('plc')).toBe('plc')
    expect(normalizeEntityType('')).toBe(null)
  })

  it('normalizeSicCodes coerces and filters', () => {
    expect(normalizeSicCodes({ sic_codes: [' 64999 ', '', null, 12345] })).toEqual(['64999', '12345'])
    expect(normalizeSicCodes({})).toEqual([])
  })
})

describe('matrix validation', () => {
  it('accepts the bundled default matrix', () => {
    expect(validateMatrix(defaultMatrixBody())).toEqual([])
  })

  it('rejects weights that do not sum to 1', () => {
    const bad = defaultMatrixBody()
    bad.weights.geographic += 0.2
    expect(validateMatrix(bad).some((e) => e.includes('weights_sum'))).toBe(true)
  })

  it('rejects unknown knockout tags and non-ascending thresholds', () => {
    const bad = defaultMatrixBody()
    bad.knockouts.madeUpTag = true
    bad.thresholds[1].min = 0
    const errs = validateMatrix(bad)
    expect(errs.some((e) => e.includes('unknown_knockout'))).toBe(true)
    expect(errs.some((e) => e.includes('ascending'))).toBe(true)
  })

  it('rejects a non-object body outright', () => {
    expect(validateMatrix(null)).toEqual(['matrix body must be a JSON object'])
  })
})
