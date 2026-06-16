import { describe, it, expect } from 'vitest'
import { ISSUE_MAP, describe as describeCode, buildHighlightedIssues } from '../services/qa/issueMap.js'
import { projectCase, buildUboList } from '../services/qa/projectCase.js'
import { checkCompleteness } from '../services/qa/completenessCheck.js'
import { checkConsistency } from '../services/qa/consistencyCheck.js'

describe('issueMap.describe', () => {
  it('returns null for a falsy code', () => {
    expect(describeCode('')).toBe(null)
    expect(describeCode(null)).toBe(null)
    expect(describeCode(undefined)).toBe(null)
  })

  it('maps a known code to its metadata', () => {
    expect(describeCode('registry_record')).toEqual(ISSUE_MAP.registry_record)
    expect(describeCode('screening_results').severity).toBe('high')
  })

  it('expands a document_status:<category>:failed warning prefix', () => {
    const d = describeCode('document_status:accounts:failed')
    expect(d.severity).toBe('low')
    expect(d.anchor).toBe('#documents')
    expect(d.message).toBe('Filing "accounts" failed to extract.')
  })

  it('defaults the document category when the prefix has no category', () => {
    const d = describeCode('document_status:')
    expect(d.message).toBe('Filing "document" failed to extract.')
  })

  it('falls back to a medium/default descriptor for an unknown code', () => {
    const d = describeCode('totally_made_up_code')
    expect(d.severity).toBe('medium')
    expect(d.anchor).toBe('#identity')
    expect(d.message).toBe('totally_made_up_code')
  })
})

describe('issueMap.buildHighlightedIssues', () => {
  it('returns an empty array for empty / no input', () => {
    expect(buildHighlightedIssues()).toEqual([])
    expect(buildHighlightedIssues({})).toEqual([])
  })

  it('maps missing codes to highlighted issues', () => {
    const out = buildHighlightedIssues({ missing: ['registry_record', 'risk_score'] })
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({ code: 'registry_record', severity: 'high', anchor: '#identity' })
    expect(out[1].code).toBe('risk_score')
  })

  it('maps warning codes (including document prefix)', () => {
    const out = buildHighlightedIssues({ warnings: ['document_status:accounts:failed'] })
    expect(out[0].message).toBe('Filing "accounts" failed to extract.')
    expect(out[0].severity).toBe('low')
  })

  it('maps consistency issues, preferring the issue message and carrying evidence', () => {
    const out = buildHighlightedIssues({
      issues: [
        { code: 'ubo_not_screened', message: 'custom msg', evidence: { missingSubjects: ['X'] } },
        { code: 'status_contradiction_registry' }, // no message → falls back to map message
      ],
    })
    expect(out[0]).toMatchObject({ code: 'ubo_not_screened', message: 'custom msg', anchor: '#screening' })
    expect(out[0].evidence).toEqual({ missingSubjects: ['X'] })
    expect(out[1].message).toBe(ISSUE_MAP.status_contradiction_registry.message)
  })

  it('combines missing + warnings + issues in order', () => {
    const out = buildHighlightedIssues({
      missing: ['risk_score'],
      warnings: ['document_status:x:failed'],
      issues: [{ code: 'ubo_not_screened' }],
    })
    expect(out.map((o) => o.code)).toEqual(['risk_score', 'document_status:x:failed', 'ubo_not_screened'])
  })
})

// ---------------------------------------------------------------------------
// projectCase — uncovered nullish branches
// ---------------------------------------------------------------------------
describe('projectCase nullish branches', () => {
  it('projects an empty state to all-null/empty fields', () => {
    const p = projectCase()
    expect(p.registry_record).toBe(null)
    expect(p.ubo_list).toEqual([])
    expect(p.screening_results).toBe(null)
    expect(p.risk_score).toBe(null)
    expect(p.risk_narrative).toBe(null)
    expect(p.document_status).toEqual([])
    expect(p.kycCard).toBe(null)
    expect(p.agent_status).toEqual({})
  })

  it('maps document_status with processedBy/error fallbacks', () => {
    const p = projectCase({
      documents: [
        { category: 'accounts', status: 'processed', processedBy: 'ocr' },
        { category: 'incorporation', status: 'failed' },
      ],
    })
    expect(p.document_status).toEqual([
      { category: 'accounts', status: 'processed', processedBy: 'ocr', error: null },
      { category: 'incorporation', status: 'failed', processedBy: null, error: null },
    ])
  })

  it('ignores a non-array documents value', () => {
    const p = projectCase({ documents: 'nope' })
    expect(p.documents).toEqual([])
    expect(p.document_status).toEqual([])
  })

  it('buildUboList: party path skips non-active and non-psc/shareholder links and dedupes by partyId', () => {
    const state = {
      parties: [
        { id: 'p1', partyType: 'organisation', fullName: 'HOLDCO LTD' },
        { id: 'p2', partyType: 'individual', fullName: 'Jane Doe' },
        { id: 'p3', partyType: 'individual', fullName: 'Ghost' },
      ],
      partyLinks: [
        { id: 'l1', partyId: 'p1', role: 'shareholder', status: 'active' },
        { id: 'l2', partyId: 'p1', role: 'psc', status: 'active' }, // dup partyId → skipped
        { id: 'l3', partyId: 'p2', role: 'officer', status: 'active' }, // officers not UBOs
        { id: 'l4', partyId: 'p3', role: 'psc', status: 'ceased' }, // not active
        { id: 'l5', partyId: 'unknown', role: 'psc', status: 'active' }, // no party row
      ],
    }
    const ubos = buildUboList(state)
    expect(ubos).toHaveLength(1)
    expect(ubos[0]).toMatchObject({ partyId: 'p1', source: 'shareholder', kind: 'corporate' })
  })

  it('buildUboList: legacy path classifies corporate PSCs and skips ceased / nameless', () => {
    const state = {
      psc: {
        items: [
          { name: 'HOLD CORP', kind: 'corporate-entity-person-with-significant-control' },
          { name: 'Gone Ltd', kind: 'legal-person', ceased: true },
          { kind: 'corporate' }, // no name
          { name: 'Jane', kind: 'individual-person-with-significant-control' },
        ],
      },
      kycCard: { shareholders: [{ name: 'Jane', type: 'individual' }, { name: 'Sub Ltd', type: 'corporate' }] },
    }
    const ubos = buildUboList(state)
    // HOLD CORP (corporate psc), Jane (psc, dedupes the shareholder), Sub Ltd (corporate shareholder)
    expect(ubos.map((u) => u.name)).toEqual(['HOLD CORP', 'Jane', 'Sub Ltd'])
    expect(ubos[0].kind).toBe('corporate')
    expect(ubos[2].kind).toBe('corporate')
  })
})

// ---------------------------------------------------------------------------
// completeness — remaining branches
// ---------------------------------------------------------------------------
describe('completenessCheck branches', () => {
  it('flags an empty UBO list', () => {
    const proj = projectCase({ profile: { company_status: 'active' }, screeningReport: {}, riskAssessment: { score: 1, rationale: 'x' } })
    const r = checkCompleteness(proj)
    expect(r.missing).toContain('ubo_list_empty')
  })

  it('flags a blank (whitespace-only) risk narrative', () => {
    const proj = projectCase({
      profile: { company_status: 'active' },
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: {},
      riskAssessment: { score: 10, rationale: '   ' },
    })
    expect(checkCompleteness(proj).missing).toContain('risk_narrative')
  })

  it('does not flag risk_score when it is 0 (falsy but present)', () => {
    const proj = projectCase({
      profile: { company_status: 'active' },
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: {},
      riskAssessment: { score: 0, rationale: 'zero risk' },
    })
    expect(checkCompleteness(proj).missing).not.toContain('risk_score')
  })

  it('treats both screening and risk skipped as not-evaluated', () => {
    const proj = projectCase({
      profile: { company_status: 'active' },
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      agentStatus: { screening: 'skipped', 'risk-assessment': 'skipped' },
    })
    const r = checkCompleteness(proj)
    expect(r.missing).not.toContain('screening_results')
    expect(r.missing).not.toContain('risk_score')
    expect(r.missing).not.toContain('risk_narrative')
  })
})

// ---------------------------------------------------------------------------
// consistency — remaining branches
// ---------------------------------------------------------------------------
describe('consistencyCheck branches', () => {
  const base = {
    profile: { company_status: 'active' },
    kycCard: { identity: { status: 'active' } },
    riskAssessment: { tier: 'Low', knockoutsTriggered: [] },
  }

  it('matches a screened UBO by partyId (no false positive)', () => {
    const proj = projectCase({
      ...base,
      parties: [{ id: 'p1', partyType: 'individual', fullName: 'Jane' }],
      partyLinks: [{ id: 'l1', partyId: 'p1', role: 'psc', status: 'active' }],
      screeningReport: { summary: { confirmedHits: 0 }, perSubject: [{ name: 'someone else', partyId: 'p1' }] },
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).not.toContain('ubo_not_screened')
  })

  it('flags tier_too_low_for_knockout when a screening knockout fired but tier is not High', () => {
    const proj = projectCase({
      ...base,
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: { summary: { confirmedHits: 0 }, perSubject: [{ name: 'A' }] },
      riskAssessment: { tier: 'Medium', knockoutsTriggered: ['screeningHighOverride'] },
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).toContain('tier_too_low_for_knockout')
  })

  it('does not flag tier_too_low_for_sanction_hit when risk was skipped', () => {
    const proj = projectCase({
      ...base,
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: { summary: { confirmedHits: 2 }, perSubject: [{ name: 'A' }] },
      riskAssessment: { tier: 'Low', knockoutsTriggered: [] },
      agentStatus: { 'risk-assessment': 'skipped' },
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).not.toContain('tier_too_low_for_sanction_hit')
  })

  it('flags status_contradiction_document on a dissolution signal vs active registry (dissolutionDate)', () => {
    const proj = projectCase({
      ...base,
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: { summary: { confirmedHits: 0 }, perSubject: [{ name: 'A' }] },
      documents: [{ category: 'accounts', transactionId: 't1', extracted: { dissolutionDate: '2021-05-05' } }],
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).toContain('status_contradiction_document')
  })

  it('flags status_contradiction_document via an extracted status === dissolved', () => {
    const proj = projectCase({
      ...base,
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: { summary: { confirmedHits: 0 }, perSubject: [{ name: 'A' }] },
      documents: [{ category: 'incorporation', transactionId: 't2', extracted: { status: 'Dissolved' } }],
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).toContain('status_contradiction_document')
  })

  it('does not flag a document contradiction when registry is not active', () => {
    const proj = projectCase({
      profile: { company_status: 'dissolved' },
      kycCard: { identity: { status: 'dissolved' } },
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: { summary: { confirmedHits: 0 }, perSubject: [{ name: 'A' }] },
      riskAssessment: { tier: 'Low', knockoutsTriggered: [] },
      documents: [{ category: 'accounts', transactionId: 't1', extracted: { status: 'dissolved' } }],
    })
    expect(checkConsistency(proj).issues.map((i) => i.code)).not.toContain('status_contradiction_document')
  })

  it('passes a clean projection (no issues)', () => {
    const proj = projectCase({
      ...base,
      psc: { items: [{ name: 'A', kind: 'individual' }] },
      screeningReport: { summary: { confirmedHits: 0 }, perSubject: [{ name: 'A' }] },
      documents: [{ category: 'accounts', transactionId: 't1', extracted: {} }],
    })
    const r = checkConsistency(proj)
    expect(r.passed).toBe(true)
    expect(r.issues).toEqual([])
  })
})
