// Phase 2 — party matcher request/response schemas + label maps (pure).
import { describe, it, expect } from 'vitest'
import {
  partyMatchInputSchema,
  partyMatchResultSchema,
  partyMergeSchema,
  reviewQueueResolutionSchema,
  CONFIDENCE_LABELS,
} from '@/lib/partyMatchSchema.js'

describe('partyMatchInputSchema', () => {
  it('accepts a minimal name-only payload', () => {
    expect(partyMatchInputSchema.safeParse({ name: 'John Smith' }).success).toBe(true)
  })
  it('rejects an empty name', () => {
    expect(partyMatchInputSchema.safeParse({ name: '   ' }).success).toBe(false)
  })
  it('rejects non-ISO2 nationality codes', () => {
    expect(partyMatchInputSchema.safeParse({ name: 'X', nationality: ['gb'] }).success).toBe(false)
    expect(partyMatchInputSchema.safeParse({ name: 'X', nationality: ['GB'] }).success).toBe(true)
  })
  it('bounds the dob year and month', () => {
    expect(partyMatchInputSchema.safeParse({ name: 'X', dob: { year: 1850 } }).success).toBe(false)
    expect(partyMatchInputSchema.safeParse({ name: 'X', dob: { month: 13 } }).success).toBe(false)
  })
})

describe('partyMatchResultSchema', () => {
  it('validates a well-formed result', () => {
    const r = partyMatchResultSchema.safeParse({
      inputCanonical: 'JOHN SMITH',
      candidates: [
        {
          partyId: '11111111-1111-4111-8111-111111111111',
          fullName: 'John Smith',
          canonical: 'JOHN SMITH',
          score: 0.92,
          confidence: 'HIGH',
          matchedVia: 'trigram',
        },
      ],
      topScore: 0.92,
    })
    expect(r.success).toBe(true)
  })
  it('rejects an unknown confidence enum', () => {
    const r = partyMatchResultSchema.safeParse({
      inputCanonical: 'X',
      candidates: [{ partyId: '11111111-1111-4111-8111-111111111111', fullName: 'X', canonical: 'X', score: 1, confidence: 'MAYBE', matchedVia: 'trigram' }],
      topScore: null,
    })
    expect(r.success).toBe(false)
  })
})

describe('partyMergeSchema', () => {
  it('requires a uuid loser id', () => {
    expect(partyMergeSchema.safeParse({ mergeFromPartyId: 'not-a-uuid' }).success).toBe(false)
    expect(partyMergeSchema.safeParse({ mergeFromPartyId: '11111111-1111-4111-8111-111111111111' }).success).toBe(true)
  })
})

describe('reviewQueueResolutionSchema', () => {
  it('discriminates merge vs reject', () => {
    expect(reviewQueueResolutionSchema.safeParse({ action: 'merge' }).success).toBe(true)
    expect(reviewQueueResolutionSchema.safeParse({ action: 'reject', reason: 'dup' }).success).toBe(true)
    expect(reviewQueueResolutionSchema.safeParse({ action: 'other' }).success).toBe(false)
  })
})

describe('CONFIDENCE_LABELS', () => {
  it('covers every confidence value', () => {
    expect(Object.keys(CONFIDENCE_LABELS).sort()).toEqual(['EXACT', 'HIGH', 'REVIEW'])
  })
})
