// Phase 0 — pure-layer smoke. Proves the harness runs plain ESM + zod, and
// gives the decision payload schema (correctness-critical, server-twinned) its
// first real coverage. Expanded in Phase 2.
import { describe, it, expect } from 'vitest'
import {
  decisionPayloadSchema,
  REASON_CODES,
  REASON_CODE_LABELS,
} from '@/lib/decisionSchema.js'

describe('decisionPayloadSchema', () => {
  it('accepts a valid approve payload', () => {
    const r = decisionPayloadSchema.safeParse({ action: 'approve', userId: 'u1' })
    expect(r.success).toBe(true)
  })

  it('rejects a reject payload with too-short freeText', () => {
    const r = decisionPayloadSchema.safeParse({
      action: 'reject',
      userId: 'u1',
      reasonCode: 'sanctions_hit',
      freeText: 'too short',
    })
    expect(r.success).toBe(false)
  })

  it('requires at least one request_info item', () => {
    const r = decisionPayloadSchema.safeParse({ action: 'request_info', userId: 'u1', items: [] })
    expect(r.success).toBe(false)
  })

  it('keeps REASON_CODES and REASON_CODE_LABELS in sync', () => {
    expect(Object.keys(REASON_CODE_LABELS).sort()).toEqual([...REASON_CODES].sort())
  })
})
