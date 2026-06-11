import { describe, it, expect } from 'vitest';
import {
  buildScreeningReport,
  effectiveDecision,
} from '../services/screening/report.js';

const SUBJECTS = [
  { id: 'party:1', name: 'Acme Ltd', kind: 'company', source: 'profile' },
  { id: 'party:2', name: 'John Smith', kind: 'individual', source: 'officers' },
];

const hit = (overrides) => ({
  hitId: 'h1',
  subjectId: 'party:2',
  listSource: 'ofac_sdn',
  ...overrides,
});

const evaluation = (overrides) => ({
  hitId: 'h1',
  decision: 'dismissed',
  category: null,
  severity: null,
  humanOverride: null,
  ...overrides,
});

// The deterministic overall-risk rule: confirmed sanctions → high; serious
// confirmed adverse media OR sanctions needs_review → medium; else low.
describe('buildScreeningReport overall risk', () => {
  it('is low with no hits', () => {
    const r = buildScreeningReport({ subjects: SUBJECTS, hits: [], evaluations: [] });
    expect(r.summary.overallRisk).toBe('low');
    expect(r.summary.subjectCount).toBe(2);
    expect(r.perSubject.find((s) => s.subjectId === 'party:2').worstStatus).toBe('clean');
  });

  it('is high on a confirmed sanctions hit', () => {
    const r = buildScreeningReport({
      subjects: SUBJECTS,
      hits: [hit({})],
      evaluations: [evaluation({ decision: 'confirmed' })],
    });
    expect(r.summary.overallRisk).toBe('high');
    expect(r.summary.confirmedHits).toBe(1);
    expect(r.byList.ofac_sdn.confirmed).toBe(1);
    expect(r.perSubject.find((s) => s.subjectId === 'party:2').worstStatus).toBe('confirmed');
  });

  it('is medium on a sanctions needs_review', () => {
    const r = buildScreeningReport({
      subjects: SUBJECTS,
      hits: [hit({})],
      evaluations: [evaluation({ decision: 'needs_review' })],
    });
    expect(r.summary.overallRisk).toBe('medium');
  });

  it('is medium on serious confirmed adverse media (fraud, severity >= medium)', () => {
    const r = buildScreeningReport({
      subjects: SUBJECTS,
      hits: [hit({ listSource: 'adverse_media' })],
      evaluations: [evaluation({ decision: 'confirmed', category: 'fraud', severity: 'high' })],
    });
    expect(r.summary.overallRisk).toBe('medium');
  });

  it('stays low on confirmed adverse media that is not serious', () => {
    const lowSeverity = buildScreeningReport({
      subjects: SUBJECTS,
      hits: [hit({ listSource: 'adverse_media' })],
      evaluations: [evaluation({ decision: 'confirmed', category: 'fraud', severity: 'low' })],
    });
    expect(lowSeverity.summary.overallRisk).toBe('low');

    const offCategory = buildScreeningReport({
      subjects: SUBJECTS,
      hits: [hit({ listSource: 'adverse_media' })],
      evaluations: [evaluation({ decision: 'confirmed', category: 'litigation', severity: 'high' })],
    });
    expect(offCategory.summary.overallRisk).toBe('low');
  });

  it('lets a human override beat the LLM decision', () => {
    const r = buildScreeningReport({
      subjects: SUBJECTS,
      hits: [hit({})],
      evaluations: [evaluation({ decision: 'confirmed', humanOverride: 'dismissed' })],
    });
    expect(r.summary.overallRisk).toBe('low');
    expect(r.summary.dismissedHits).toBe(1);
    expect(r.summary.confirmedHits).toBe(0);
  });
});

describe('effectiveDecision', () => {
  it('is unevaluated without an evaluation row', () => {
    expect(effectiveDecision(null)).toBe('unevaluated');
  });

  it('prefers the human override when present', () => {
    expect(effectiveDecision({ decision: 'confirmed', humanOverride: 'dismissed' })).toBe('dismissed');
    expect(effectiveDecision({ decision: 'confirmed', humanOverride: null })).toBe('confirmed');
  });
});
