import { describe, it, expect } from 'vitest'
import {
  stateSchema,
  traceEvent,
  errorEvent,
  DecisionFragmentSchema,
  SubjectSchema,
  HitSchema,
  EvaluationSchema,
  ScreeningReportSchema,
  RiskAssessmentSchema,
  QaResultSchema,
  QaNarrativeSchema,
} from '../graph/state.js'

describe('traceEvent / errorEvent', () => {
  it('traceEvent stamps node, msg, ts and omits extra when absent', () => {
    const e = traceEvent('search_ch', 'searching')
    expect(e.node).toBe('search_ch')
    expect(e.msg).toBe('searching')
    expect(typeof e.ts).toBe('number')
    expect('extra' in e).toBe(false)
  })

  it('traceEvent attaches extra when provided', () => {
    const e = traceEvent('n', 'm', { count: 3 })
    expect(e.extra).toEqual({ count: 3 })
  })

  it('errorEvent stamps node, message and ts', () => {
    const e = errorEvent('fetch_apis', 'boom')
    expect(e).toMatchObject({ node: 'fetch_apis', message: 'boom' })
    expect(typeof e.ts).toBe('number')
  })
})

// withLangGraph channels are required at the Zod level (their defaults/reducers
// are applied by LangGraph at runtime, not by stateSchema.parse). A valid state
// object must therefore carry the array + record channels explicitly.
const baseState = () => ({
  input: {},
  candidates: [],
  documents: [],
  trace: [],
  errors: [],
  fragments: [],
  parties: [],
  partyLinks: [],
  screeningSubjects: [],
  screeningHits: [],
  screeningEvaluations: [],
  agentStatus: {},
})

describe('stateSchema agentStatus channel', () => {
  it('parses a fully-populated base state', () => {
    const parsed = stateSchema.parse(baseState())
    expect(parsed.candidates).toEqual([])
    expect(parsed.agentStatus).toEqual({})
  })

  it('rejects an invalid agentStatus enum value', () => {
    expect(() => stateSchema.parse({ ...baseState(), agentStatus: { screening: 'paused' } })).toThrow()
  })

  it('accepts the three valid agentStatus values', () => {
    const parsed = stateSchema.parse({
      ...baseState(),
      agentStatus: { screening: 'skipped', qa: 'completed', risk: 'failed' },
    })
    expect(parsed.agentStatus.screening).toBe('skipped')
  })

  it('validates candidate entries and resolution status enum', () => {
    const parsed = stateSchema.parse({
      ...baseState(),
      candidates: [{ companyNumber: '123', title: 'ACME', apiRank: 1, score: 0.9 }],
      resolution: { status: 'auto_match', chosen: '123' },
    })
    expect(parsed.resolution.status).toBe('auto_match')
    expect(() => stateSchema.parse({ ...baseState(), resolution: { status: 'bogus' } })).toThrow()
  })
})

describe('sub-schema validation', () => {
  it('DecisionFragmentSchema requires the core fields and a valid kind/status', () => {
    const ok = DecisionFragmentSchema.parse({
      id: 'f1',
      nodeId: 'assess_risk',
      sequence: 1,
      kind: 'decision',
      status: 'ok',
      startedAt: 1,
      summary: 'done',
    })
    expect(ok.kind).toBe('decision')
    expect(() =>
      DecisionFragmentSchema.parse({ id: 'f', nodeId: 'n', sequence: 1, kind: 'bogus', status: 'ok', startedAt: 1, summary: 's' })
    ).toThrow()
  })

  it('SubjectSchema validates kind + source enums', () => {
    const s = SubjectSchema.parse({ id: 's1', name: 'A', normalizedName: 'a', kind: 'individual', source: 'psc' })
    expect(s.kind).toBe('individual')
    expect(() => SubjectSchema.parse({ id: 's', name: 'A', normalizedName: 'a', kind: 'alien', source: 'psc' })).toThrow()
  })

  it('HitSchema accepts nullable match fields', () => {
    const h = HitSchema.parse({
      hitId: 'h1',
      subjectId: 's1',
      subjectName: 'A',
      subjectKind: 'company',
      subjectSource: 'profile',
      listSource: 'ofac_sdn',
      matchScore: null,
      listEntryId: null,
      rawEntry: { x: 1 },
    })
    expect(h.matchScore).toBe(null)
  })

  it('EvaluationSchema restricts decision + severity enums', () => {
    const e = EvaluationSchema.parse({ hitId: 'h', decision: 'confirmed', severity: 'high', llmReasoning: 'r' })
    expect(e.decision).toBe('confirmed')
    expect(() => EvaluationSchema.parse({ hitId: 'h', decision: 'maybe', llmReasoning: 'r' })).toThrow()
  })

  it('ScreeningReportSchema defaults perSubject and byList', () => {
    const r = ScreeningReportSchema.parse({
      summary: { subjectCount: 1, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' },
    })
    expect(r.perSubject).toEqual([])
    expect(r.byList).toEqual({})
  })

  it('RiskAssessmentSchema defaults deltaFlagged and arrays', () => {
    const r = RiskAssessmentSchema.parse({ score: 10, tier: 'Low', outcome: 'Low', calculatedAt: 'now' })
    expect(r.deltaFlagged).toBe(false)
    expect(r.factors).toEqual([])
    expect(r.knockoutsTriggered).toEqual([])
    expect(() => RiskAssessmentSchema.parse({ score: 1, tier: 'Severe', outcome: 'Low', calculatedAt: 'now' })).toThrow()
  })

  it('QaResultSchema validates nested routing.caseStatus enum', () => {
    const base = {
      passed: true,
      completeness: { passed: true },
      consistency: { passed: true },
      routing: { caseStatus: 'auto_approved', qaSummary: 's' },
      qaSummary: 's',
      evaluatedAt: 'now',
    }
    expect(QaResultSchema.parse(base).routing.caseStatus).toBe('auto_approved')
    expect(() => QaResultSchema.parse({ ...base, routing: { caseStatus: 'approved', qaSummary: 's' } })).toThrow()
  })

  it('QaNarrativeSchema requires text + integer paragraphCount', () => {
    const n = QaNarrativeSchema.parse({ text: 'memo', paragraphCount: 2, tier: 'Low', generatedAt: 'now' })
    expect(n.paragraphCount).toBe(2)
    expect(() => QaNarrativeSchema.parse({ text: 'm', paragraphCount: 1.5, tier: 'Low', generatedAt: 'now' })).toThrow()
  })
})
