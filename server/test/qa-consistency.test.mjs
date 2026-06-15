// Phase 1 — the consistency-check branches the existing qa-checks suite leaves
// uncovered: knockout-vs-tier, document dissolution signal, the risk-skipped
// suppression, and the party-id UBO matching path.
import { describe, it, expect } from 'vitest';
import { checkConsistency } from '../services/qa/consistencyCheck.js';
import { projectCase, buildUboList } from '../services/qa/projectCase.js';

const codes = (r) => r.issues.map((i) => i.code);

describe('checkConsistency — knockout vs tier', () => {
  it('flags tier_too_low_for_knockout when a screening knockout fired but tier is not High', () => {
    const proj = {
      screening_results: { perSubject: [], summary: { confirmedHits: 0 } },
      riskAssessment: { tier: 'Medium', knockoutsTriggered: ['screeningHighOverride'] },
    };
    expect(codes(checkConsistency(proj))).toContain('tier_too_low_for_knockout');
  });

  it('does not flag when the knockout produced a High tier', () => {
    const proj = {
      screening_results: { perSubject: [], summary: { confirmedHits: 0 } },
      riskAssessment: { tier: 'High', knockoutsTriggered: ['screeningProhibited'] },
    };
    expect(codes(checkConsistency(proj))).not.toContain('tier_too_low_for_knockout');
  });

  it('ignores non-screening knockouts', () => {
    const proj = {
      screening_results: { perSubject: [], summary: { confirmedHits: 0 } },
      riskAssessment: { tier: 'Low', knockoutsTriggered: ['someOtherKnockout'] },
    };
    expect(codes(checkConsistency(proj))).not.toContain('tier_too_low_for_knockout');
  });
});

describe('checkConsistency — risk skipped suppresses the sanction-hit tier check', () => {
  it('does not flag tier_too_low_for_sanction_hit when risk was skipped', () => {
    const proj = {
      agent_status: { 'risk-assessment': 'skipped' },
      screening_results: { perSubject: [], summary: { confirmedHits: 2 } },
      riskAssessment: null,
    };
    expect(codes(checkConsistency(proj))).not.toContain('tier_too_low_for_sanction_hit');
  });
});

describe('checkConsistency — document dissolution signal', () => {
  const activeRegistry = { registry_record: { company_status: 'active' } };

  it('flags status_contradiction_document on an extracted dissolutionDate', () => {
    const proj = {
      ...activeRegistry,
      documents: [{ category: 'accounts', transactionId: 't1', extracted: { dissolutionDate: '2023-01-01' } }],
    };
    expect(codes(checkConsistency(proj))).toContain('status_contradiction_document');
  });

  it('flags on an extracted status of "dissolved"', () => {
    const proj = {
      ...activeRegistry,
      documents: [{ category: 'accounts', extracted: { status: 'Dissolved' } }],
    };
    expect(codes(checkConsistency(proj))).toContain('status_contradiction_document');
  });

  it('does not flag when the registry is not active', () => {
    const proj = {
      registry_record: { company_status: 'dissolved' },
      documents: [{ category: 'accounts', extracted: { status: 'dissolved' } }],
    };
    expect(codes(checkConsistency(proj))).not.toContain('status_contradiction_document');
  });

  it('does not flag when no document carries a dissolution field', () => {
    const proj = { ...activeRegistry, documents: [{ category: 'accounts', extracted: { turnover: 100 } }] };
    expect(codes(checkConsistency(proj))).not.toContain('status_contradiction_document');
  });
});

describe('checkConsistency — UBO matching', () => {
  it('treats a UBO matched by partyId as screened', () => {
    const proj = {
      ubo_list: [{ name: 'Jane Holder', partyId: 'p1', normalizedName: 'JANE HOLDER' }],
      screening_results: { perSubject: [{ name: 'different surface form', partyId: 'p1' }], summary: { confirmedHits: 0 } },
    };
    expect(codes(checkConsistency(proj))).not.toContain('ubo_not_screened');
  });

  it('skips a UBO that carries neither a partyId nor a normalizedName', () => {
    const proj = {
      ubo_list: [{ name: 'Mystery' }],
      screening_results: { perSubject: [], summary: { confirmedHits: 0 } },
    };
    expect(codes(checkConsistency(proj))).not.toContain('ubo_not_screened');
  });

  it('passes a fully consistent projection', () => {
    const proj = { screening_results: { perSubject: [], summary: { confirmedHits: 0 } } };
    expect(checkConsistency(proj).passed).toBe(true);
  });
});

describe('buildUboList — party-resolved path', () => {
  it('builds UBOs from active psc/shareholder links, deduped by partyId, skipping officers and ceased links', () => {
    const state = {
      parties: [
        { id: 'p1', partyType: 'individual', fullName: 'Jane Holder' },
        { id: 'p2', partyType: 'organisation', fullName: 'Parent Co' },
        { id: 'p3', partyType: 'individual', fullName: 'Director Only' },
      ],
      partyLinks: [
        { partyId: 'p1', role: 'psc', status: 'active' },
        { partyId: 'p1', role: 'shareholder', status: 'active' }, // dup partyId → collapsed
        { partyId: 'p2', role: 'shareholder', status: 'active' },
        { partyId: 'p3', role: 'officer', status: 'active' }, // officers are not UBOs
        { partyId: 'p2', role: 'psc', status: 'historical' }, // inactive
      ],
    };
    const ubos = buildUboList(state);
    expect(ubos.map((u) => u.partyId).sort()).toEqual(['p1', 'p2']);
    expect(ubos.find((u) => u.partyId === 'p2').kind).toBe('corporate');
  });
});

describe('projectCase — document_status passthrough', () => {
  it('projects per-document status with processedBy/error defaults', () => {
    const proj = projectCase({ documents: [{ category: 'accounts', status: 'done' }] });
    expect(proj.document_status[0]).toEqual({ category: 'accounts', status: 'done', processedBy: null, error: null });
  });
});
