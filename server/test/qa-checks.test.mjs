import { describe, it, expect } from 'vitest'
import { projectCase, buildUboList } from '../services/qa/projectCase.js'
import { checkCompleteness } from '../services/qa/completenessCheck.js'
import { checkConsistency } from '../services/qa/consistencyCheck.js'
import { evaluateQa } from '../services/qa/index.js'

const FULL_STATE = {
  profile: { company_status: 'active' },
  psc: { items: [{ name: 'Jane Holder', kind: 'individual-person-with-significant-control' }] },
  kycCard: {
    identity: { name: 'ACME LTD', companyNumber: '123', status: 'active' },
    shareholders: [{ name: 'Jane Holder', type: 'individual' }],
  },
  screeningReport: {
    summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' },
    perSubject: [{ name: 'Jane Holder', partyId: null }],
  },
  riskAssessment: { score: 12, tier: 'Low', rationale: 'Low risk profile.', knockoutsTriggered: [] },
  documents: [],
}

describe('projectCase / buildUboList', () => {
  it('prefers the party-resolved UBO list when links exist', () => {
    const state = {
      ...FULL_STATE,
      parties: [{ id: 'p1', partyType: 'individual', fullName: 'Jane Holder' }],
      partyLinks: [{ id: 'l1', partyId: 'p1', role: 'psc', status: 'active' }],
    }
    const ubos = buildUboList(state)
    expect(ubos).toHaveLength(1)
    expect(ubos[0].partyId).toBe('p1')
  })

  it('falls back to raw PSC + shareholders without the resolver', () => {
    const ubos = buildUboList(FULL_STATE)
    expect(ubos.map((u) => u.source)).toEqual(['psc']) // shareholder deduped by name
  })

  it('skips ceased PSCs in the legacy path', () => {
    const state = { psc: { items: [{ name: 'Gone Corp', kind: 'corporate', ceased_on: '2020-01-01' }] }, kycCard: { shareholders: [] } }
    expect(buildUboList(state)).toHaveLength(0)
  })

  it('passes agent status through the projection', () => {
    const proj = projectCase({ ...FULL_STATE, agentStatus: { screening: 'skipped' } })
    expect(proj.agent_status.screening).toBe('skipped')
  })
})

describe('checkCompleteness degraded mode', () => {
  it('passes a complete projection', () => {
    expect(checkCompleteness(projectCase(FULL_STATE)).passed).toBe(true)
  })

  it('fails on a missing screening report when screening ran', () => {
    const proj = projectCase({ ...FULL_STATE, screeningReport: undefined })
    const r = checkCompleteness(proj)
    expect(r.passed).toBe(false)
    expect(r.missing).toContain('screening_results')
  })

  it('treats a skipped screening agent as not-evaluated, not missing', () => {
    const proj = projectCase({ ...FULL_STATE, screeningReport: undefined, agentStatus: { screening: 'skipped' } })
    expect(checkCompleteness(proj).missing).not.toContain('screening_results')
  })

  it('treats skipped risk as not-evaluated for score and narrative', () => {
    const proj = projectCase({ ...FULL_STATE, riskAssessment: undefined, agentStatus: { 'risk-assessment': 'skipped' } })
    const r = checkCompleteness(proj)
    expect(r.missing).not.toContain('risk_score')
    expect(r.missing).not.toContain('risk_narrative')
  })

  it('downgrades document failures to warnings', () => {
    const proj = projectCase({ ...FULL_STATE, documents: [{ category: 'accounts', status: 'failed', transactionId: 't1' }] })
    const r = checkCompleteness(proj)
    expect(r.passed).toBe(true)
    expect(r.warnings).toContain('document_status:accounts:failed')
  })
})

describe('checkConsistency', () => {
  it('flags an unscreened UBO', () => {
    const proj = projectCase({ ...FULL_STATE, screeningReport: { ...FULL_STATE.screeningReport, perSubject: [] } })
    const r = checkConsistency(proj)
    expect(r.issues.map((i) => i.code)).toContain('ubo_not_screened')
  })

  it('does not flag unscreened UBOs when screening was skipped', () => {
    const proj = projectCase({
      ...FULL_STATE,
      screeningReport: undefined,
      agentStatus: { screening: 'skipped' },
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).not.toContain('ubo_not_screened')
  })

  it('flags confirmed sanctions hits with a non-High tier', () => {
    const proj = projectCase({
      ...FULL_STATE,
      screeningReport: { ...FULL_STATE.screeningReport, summary: { ...FULL_STATE.screeningReport.summary, confirmedHits: 1 } },
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).toContain('tier_too_low_for_sanction_hit')
  })

  it('flags a registry/card status contradiction', () => {
    const proj = projectCase({
      ...FULL_STATE,
      profile: { company_status: 'dissolved' },
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).toContain('status_contradiction_registry')
  })
})

describe('evaluateQa end to end (pure)', () => {
  it('auto-approves a clean Low-tier case', () => {
    const r = evaluateQa({ state: FULL_STATE, matrix: { body: {} } })
    expect(r.passed).toBe(true)
    expect(r.routing.caseStatus).toBe('auto_approved')
  })

  it('routes to standard review and records skippedAgents when screening was disabled', () => {
    const r = evaluateQa({
      state: { ...FULL_STATE, screeningReport: undefined, agentStatus: { screening: 'skipped' } },
      matrix: { body: {} },
    })
    expect(r.routing.caseStatus).toBe('standard_review')
    expect(r.skippedAgents).toEqual(['screening'])
  })
})
