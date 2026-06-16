// Phase 2 — useDecision composable: success + every error branch.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useDecision } from '@/composables/useDecision.js'

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: () => Promise.resolve(body) }
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

describe('useDecision', () => {
  it('throws when companyNumber or runId is missing', async () => {
    const { submitDecision } = useDecision()
    await expect(submitDecision({ runId: 'r1', payload: {} })).rejects.toThrow(/required/)
  })

  it('returns the body and toggles submitting on success', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ ok: true, caseStatus: 'approved' }))
    const { submitDecision, submitting, error } = useDecision()
    const body = await submitDecision({ companyNumber: '123', runId: 'r1', payload: { action: 'approve', userId: 'u' } })
    expect(body.caseStatus).toBe('approved')
    expect(submitting.value).toBe(false)
    expect(error.value).toBeNull()
  })

  it('surfaces 400 validationErrors', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ validationErrors: [{ path: 'freeText' }] }, { ok: false, status: 400 }))
    const { submitDecision, validationErrors, error } = useDecision()
    await expect(submitDecision({ companyNumber: '1', runId: 'r', payload: {} })).rejects.toBeTruthy()
    expect(validationErrors.value).toEqual([{ path: 'freeText' }])
    expect(error.value).toMatch(/Invalid payload/)
  })

  it('explains a 409 from a finalised state', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ error: 'invalid_transition', from: 'approved' }, { ok: false, status: 409 }))
    const { submitDecision, error } = useDecision()
    await expect(submitDecision({ companyNumber: '1', runId: 'r', payload: { action: 'approve' } })).rejects.toBeTruthy()
    expect(error.value).toMatch(/already been finalised \(approved\)/)
  })

  it('explains a 409 from a non-terminal state', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ error: 'invalid_transition', from: 'pending', action: 'approve' }, { ok: false, status: 409 }))
    const { submitDecision, error } = useDecision()
    await expect(submitDecision({ companyNumber: '1', runId: 'r', payload: { action: 'approve' } })).rejects.toBeTruthy()
    expect(error.value).toMatch(/Cannot approve a case in state "pending"/)
  })

  it('falls back to a generic message on other errors', async () => {
    globalThis.fetch.mockResolvedValue(jsonRes({ error: 'boom' }, { ok: false, status: 500 }))
    const { submitDecision, error } = useDecision()
    await expect(submitDecision({ companyNumber: '1', runId: 'r', payload: {} })).rejects.toBeTruthy()
    expect(error.value).toBe('boom')
  })
})
