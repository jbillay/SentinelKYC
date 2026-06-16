import { describe, it, expect } from 'vitest'
import {
  validateMatrix,
  assertValidMatrix,
  defaultMatrixBody,
  invalidate,
  DEFAULT_MATRIX,
  KNOWN_KNOCKOUT_TAGS,
} from '../services/risk/matrix.js'

// A known-valid matrix used as the base for targeted mutation tests. Mutating
// one field at a time lets each test pin a single validation branch.
const valid = () => defaultMatrixBody()

describe('matrix.defaultMatrixBody / DEFAULT_MATRIX', () => {
  it('returns a deep clone (mutation does not leak back into DEFAULT_MATRIX)', () => {
    const a = defaultMatrixBody()
    a.weights.geographic = 0.999
    expect(DEFAULT_MATRIX.weights.geographic).not.toBe(0.999)
    // two clones are independent
    expect(defaultMatrixBody().weights.geographic).not.toBe(0.999)
  })

  it('exposes the known knockout tags', () => {
    expect(KNOWN_KNOCKOUT_TAGS).toEqual(
      expect.arrayContaining(['screeningProhibited', 'screeningHighOverride', 'screeningMediumFloor'])
    )
  })

  it('the default body validates clean', () => {
    expect(validateMatrix(defaultMatrixBody())).toEqual([])
  })
})

describe('validateMatrix — non-object / weights', () => {
  it('rejects null, arrays, and non-objects', () => {
    expect(validateMatrix(null)).toEqual(['matrix body must be a JSON object'])
    expect(validateMatrix([])).toEqual(['matrix body must be a JSON object'])
    expect(validateMatrix(42)).toEqual(['matrix body must be a JSON object'])
  })

  it('flags a missing weights object', () => {
    const b = valid()
    delete b.weights
    expect(validateMatrix(b)).toContain('missing weights object')
  })

  it('flags a non-numeric weight', () => {
    const b = valid()
    b.weights.geographic = 'x'
    expect(validateMatrix(b).some((e) => e === 'weights.geographic must be a number')).toBe(true)
  })

  it('flags a weight out of [0,1]', () => {
    const b = valid()
    // push one weight above 1, compensate another so the only error is the range one
    b.weights.geographic = 1.5
    b.weights.entityType = b.weights.entityType - 0.5
    expect(validateMatrix(b).some((e) => e.includes('weights.geographic must be in [0,1]'))).toBe(true)
  })

  it('flags weights that do not sum to 1', () => {
    const b = valid()
    b.weights.geographic += 0.3
    expect(validateMatrix(b).some((e) => e.includes('weights_sum'))).toBe(true)
  })
})

describe('validateMatrix — factors.geographic', () => {
  it('flags a missing geographic factor', () => {
    const b = valid()
    delete b.factors.geographic
    expect(validateMatrix(b)).toContain('missing factors.geographic')
  })

  it('flags a non-score default', () => {
    const b = valid()
    b.factors.geographic.default = 200
    expect(validateMatrix(b)).toContain('factors.geographic.default must be a score 0-100')
  })

  it('flags a non-object scores map', () => {
    const b = valid()
    b.factors.geographic.scores = []
    expect(validateMatrix(b)).toContain('factors.geographic.scores must be an object')
  })

  it('flags an out-of-range per-country score', () => {
    const b = valid()
    b.factors.geographic.scores.ZZ = 150
    expect(validateMatrix(b).some((e) => e.includes('factors.geographic.scores.ZZ'))).toBe(true)
  })
})

describe('validateMatrix — factors.entityType', () => {
  it('flags a missing entityType factor', () => {
    const b = valid()
    delete b.factors.entityType
    expect(validateMatrix(b)).toContain('missing factors.entityType')
  })

  it('flags a non-object entityType scores map and a bad score', () => {
    const b = valid()
    b.factors.entityType.scores = null
    expect(validateMatrix(b)).toContain('factors.entityType.scores must be an object')

    const b2 = valid()
    b2.factors.entityType.scores.ltd = -1
    expect(validateMatrix(b2).some((e) => e.includes('factors.entityType.scores.ltd'))).toBe(true)
  })
})

describe('validateMatrix — factors.structuralComplexity', () => {
  it('flags a missing factor', () => {
    const b = valid()
    delete b.factors.structuralComplexity
    expect(validateMatrix(b)).toContain('missing factors.structuralComplexity')
  })

  it('requires combineRule === max', () => {
    const b = valid()
    b.factors.structuralComplexity.combineRule = 'sum'
    expect(validateMatrix(b)).toContain("factors.structuralComplexity.combineRule must be 'max'")
  })

  it('flags an empty tiers array', () => {
    const b = valid()
    b.factors.structuralComplexity.corporatePscCount.tiers = []
    expect(
      validateMatrix(b).some((e) => e.includes('corporatePscCount.tiers must be a non-empty array'))
    ).toBe(true)
  })

  it('flags a non-ascending upTo', () => {
    const b = valid()
    b.factors.structuralComplexity.corporatePscCount.tiers = [
      { upTo: 5, score: 10 },
      { upTo: 5, score: 20 },
      { upTo: null, score: 30 },
    ]
    expect(validateMatrix(b).some((e) => e.includes('strictly ascending upTo'))).toBe(true)
  })

  it('flags an open-ended tier that is not last', () => {
    const b = valid()
    b.factors.structuralComplexity.shareholderLayers.tiers = [
      { upTo: null, score: 10 },
      { upTo: 5, score: 20 },
    ]
    const errs = validateMatrix(b)
    expect(errs.some((e) => e.includes('open-ended tier (upTo:null) must be last'))).toBe(true)
  })

  it('flags a last tier that is NOT open-ended', () => {
    const b = valid()
    b.factors.structuralComplexity.corporatePscCount.tiers = [
      { upTo: 1, score: 10 },
      { upTo: 9, score: 20 },
    ]
    expect(
      validateMatrix(b).some((e) => e.includes('last tier must be open-ended (upTo:null)'))
    ).toBe(true)
  })

  it('flags a non-number, non-null upTo', () => {
    const b = valid()
    b.factors.structuralComplexity.corporatePscCount.tiers = [
      { upTo: 'nope', score: 10 },
      { upTo: null, score: 20 },
    ]
    expect(validateMatrix(b).some((e) => e.includes('upTo must be a number or null'))).toBe(true)
  })

  it('flags a non-score tier score', () => {
    const b = valid()
    b.factors.structuralComplexity.corporatePscCount.tiers[0].score = 500
    expect(validateMatrix(b).some((e) => e.includes('tiers[0].score must be a score 0-100'))).toBe(true)
  })
})

describe('validateMatrix — factors.industry', () => {
  it('flags a missing factor', () => {
    const b = valid()
    delete b.factors.industry
    expect(validateMatrix(b)).toContain('missing factors.industry')
  })

  it('requires combineRule === max and a numeric default', () => {
    const b = valid()
    b.factors.industry.combineRule = 'sum'
    b.factors.industry.default = 'x'
    const errs = validateMatrix(b)
    expect(errs).toContain("factors.industry.combineRule must be 'max'")
    expect(errs).toContain('factors.industry.default must be a score 0-100')
  })

  it('flags a non-array prefixes', () => {
    const b = valid()
    b.factors.industry.prefixes = {}
    expect(validateMatrix(b)).toContain('factors.industry.prefixes must be an array')
  })

  it('flags an empty prefix string and a bad prefix score', () => {
    const b = valid()
    b.factors.industry.prefixes = [{ prefix: '', score: 150 }]
    const errs = validateMatrix(b)
    expect(errs.some((e) => e.includes('prefixes[0].prefix must be a non-empty string'))).toBe(true)
    expect(errs.some((e) => e.includes('prefixes[0].score must be a score 0-100'))).toBe(true)
  })
})

describe('validateMatrix — thresholds', () => {
  it('flags a non-array / empty thresholds', () => {
    const b = valid()
    b.thresholds = []
    expect(validateMatrix(b)).toContain('thresholds must be a non-empty array')
  })

  it('flags a missing tier name and non-numeric min/max', () => {
    const b = valid()
    b.thresholds = [{ tier: '', min: 'a', max: 'b' }]
    const errs = validateMatrix(b)
    expect(errs.some((e) => e.includes('thresholds[0].tier must be a non-empty string'))).toBe(true)
    expect(errs.some((e) => e.includes('thresholds[0] must have numeric min and max'))).toBe(true)
  })

  it('flags min > max', () => {
    const b = valid()
    b.thresholds = [{ tier: 'Low', min: 50, max: 10 }, { tier: 'High', min: 51, max: 100 }]
    expect(validateMatrix(b).some((e) => e.includes('min must be <= max'))).toBe(true)
  })

  it('flags thresholds not starting at 0 and not reaching 100', () => {
    const b = valid()
    b.thresholds = [
      { tier: 'Low', min: 5, max: 40 },
      { tier: 'High', min: 41, max: 90 },
    ]
    const errs = validateMatrix(b)
    expect(errs).toContain('thresholds must start at min=0')
    expect(errs).toContain('thresholds must cover up to 100')
  })
})

describe('validateMatrix — knockouts / trajectory', () => {
  it('flags a missing knockouts object', () => {
    const b = valid()
    delete b.knockouts
    expect(validateMatrix(b)).toContain('missing knockouts object')
  })

  it('flags an unknown knockout tag and a non-boolean value', () => {
    const b = valid()
    b.knockouts.madeUp = true
    b.knockouts.screeningProhibited = 'yes'
    const errs = validateMatrix(b)
    expect(errs.some((e) => e.includes('unknown_knockout'))).toBe(true)
    expect(errs.some((e) => e.includes('knockouts.screeningProhibited must be a boolean'))).toBe(true)
  })

  it('flags a missing trajectory and a negative deltaFlagThreshold', () => {
    const b = valid()
    delete b.trajectory
    expect(validateMatrix(b)).toContain('missing trajectory object')

    const b2 = valid()
    b2.trajectory.deltaFlagThreshold = -3
    expect(validateMatrix(b2)).toContain('trajectory.deltaFlagThreshold must be a non-negative number')
  })
})

describe('assertValidMatrix / invalidate', () => {
  it('does not throw on a valid body', () => {
    expect(() => assertValidMatrix(defaultMatrixBody())).not.toThrow()
  })

  it('throws with a validationErrors array on an invalid body', () => {
    let caught
    try {
      assertValidMatrix(null)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(Array.isArray(caught.validationErrors)).toBe(true)
    expect(caught.validationErrors.length).toBeGreaterThan(0)
    expect(caught.message).toMatch(/Invalid risk matrix/)
  })

  it('invalidate() is callable and idempotent (clears the in-process cache)', () => {
    expect(() => {
      invalidate()
      invalidate()
    }).not.toThrow()
  })
})
