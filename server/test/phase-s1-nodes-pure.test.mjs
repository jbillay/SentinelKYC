// S1 — Pure-path unit tests for graph/nodes.
//
// Nodes covered:
//   searchCh             — early-return guard (no input) + error-catch guard
//                          (real CH unreachable in CI → failed fragment)
//   fetchApis            — early-return guard (no companyNumber)
//   downloadDocuments    — early-return guards (empty docs, missing CN)
//   awaitConfirmation    — interrupt() throws outside a graph; withFragment
//                          catches and produces a failed fragment — exercises
//                          the validation-before-interrupt path
//   compileScreeningList — pure legacy and party-keyed paths (no I/O)
//   compileScreeningReport — pure (buildScreeningReport wrapper)
//   qaSkipped            — pure stamp node
//   entityResolution     — deterministic scoring (mocked loadAgentConfig)
//
// Registry-bound lookups (searchCh name search, fetchApis, downloadDocuments
// download) and awaitDecision need a DI refactor to be testable offline — see
// graph-nodes.int.test.mjs comment header for the acknowledged limitation.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

// ─── Agents config mock (entityResolution reads autoMatchThreshold etc.) ─────
vi.mock('../agents/config', () => ({
  loadAgentConfig: vi.fn(async () => ({
    autoMatchThreshold: 0.85,
    autoMatchLead: 0.2,
    maxCandidates: 5,
  })),
  seedAgentConfigs: vi.fn(async () => {}),
}));

// ─── Load nodes after mocks are installed ────────────────────────────────────
const require = createRequire(import.meta.url);

const { searchCh } = require('../graph/nodes/searchCh.js');
const { fetchApis } = require('../graph/nodes/fetchApis.js');
const { downloadDocuments } = require('../graph/nodes/downloadDocuments.js');
const { compileScreeningList } = require('../graph/nodes/screening/compileScreeningList.js');
const { compileScreeningReport } = require('../graph/nodes/screening/compileScreeningReport.js');
const { qaSkipped } = require('../graph/nodes/qaSkipped.js');
const { awaitConfirmation } = require('../graph/nodes/awaitConfirmation.js');
const { entityResolution } = require('../graph/nodes/entityResolution.js');

// ─────────────────────────────────────────────────────────────────────────────
// searchCh
// ─────────────────────────────────────────────────────────────────────────────
describe('searchCh', () => {
  it('returns skipped fragment when no name and no company number', async () => {
    const out = await searchCh({ input: {} }, {});
    expect(out.candidates).toHaveLength(0);
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('returns failed fragment when company number lookup throws (CH unavailable in CI)', async () => {
    // The real registry getProfile call fails in unit tests (no CH access);
    // the node catches and returns a failed fragment — exercises the error path.
    const out = await searchCh({ input: { companyNumber: '01234567' } }, {});
    expect(out.candidates).toHaveLength(0);
    expect(out.fragments.at(-1).status).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// fetchApis
// ─────────────────────────────────────────────────────────────────────────────
describe('fetchApis', () => {
  it('returns skipped fragment when companyNumber is missing', async () => {
    const out = await fetchApis({ companyNumber: null }, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// downloadDocuments
// ─────────────────────────────────────────────────────────────────────────────
describe('downloadDocuments', () => {
  it('returns skipped when documents array is empty', async () => {
    const out = await downloadDocuments({ documents: [], companyNumber: '01234567' }, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('returns failed when companyNumber is missing', async () => {
    const out = await downloadDocuments({
      documents: [{ transactionId: 'tx1', category: 'accounts' }],
      companyNumber: null,
    }, {});
    expect(out.fragments.at(-1).status).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// awaitConfirmation
// interrupt() called outside a graph throws; withFragment catches the error and
// produces a failed fragment.  The validation guards before the interrupt call
// also produce a failed fragment, so both paths reach the same terminal state.
// ─────────────────────────────────────────────────────────────────────────────
describe('awaitConfirmation (interrupt outside graph → failed fragment)', () => {
  const CANDIDATES = [
    { companyNumber: '01234567', title: 'ACME LTD', score: 1.2 },
    { companyNumber: '09999999', title: 'ACME PLC', score: 0.6 },
  ];
  const RESOLUTION = { status: 'needs_user_pick' };

  it('produces a failed fragment when called outside a graph (no companyNumber in payload)', async () => {
    const out = await awaitConfirmation({ resolution: RESOLUTION, candidates: CANDIDATES }, {});
    expect(out.fragments.at(-1).status).toBe('failed');
  });

  it('produces a failed fragment on a second direct call (no chosen companyNumber)', async () => {
    const out = await awaitConfirmation({ resolution: RESOLUTION, candidates: CANDIDATES }, {});
    expect(out.fragments.at(-1).status).toBe('failed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileScreeningList
// ─────────────────────────────────────────────────────────────────────────────
describe('compileScreeningList', () => {
  it('compiles subjects from profile + officers + PSC (legacy path)', async () => {
    const state = {
      profile: { company_name: 'ACME LTD' },
      officers: { items: [{ name: 'Jane Smith', officer_role: 'director' }] },
      psc: { items: [{ name: 'John Doe', kind: 'individual-person-with-significant-control' }] },
      kycCard: { shareholders: [] },
    };
    const out = await compileScreeningList(state, {});
    expect(out.screeningSubjects.length).toBeGreaterThanOrEqual(3);
    const company = out.screeningSubjects.find((s) => s.source === 'profile');
    expect(company?.kind).toBe('company');
    const officer = out.screeningSubjects.find((s) => s.source === 'officer');
    expect(officer?.name).toBe('Jane Smith');
  });

  it('skips resigned officers', async () => {
    const state = {
      profile: { company_name: 'ACME LTD' },
      officers: {
        items: [
          { name: 'Active Director', officer_role: 'director' },
          { name: 'Old Director', officer_role: 'director', resigned_on: '2020-01-01' },
        ],
      },
      psc: { items: [] },
      kycCard: { shareholders: [] },
    };
    const out = await compileScreeningList(state, {});
    const officers = out.screeningSubjects.filter((s) => s.source === 'officer');
    expect(officers).toHaveLength(1);
    expect(officers[0].name).toBe('Active Director');
  });

  it('dedupes shareholders already covered by PSC (normalised match)', async () => {
    const state = {
      profile: { company_name: 'ACME LTD' },
      officers: { items: [] },
      psc: { items: [{ name: 'Jane Smith', kind: 'individual-person-with-significant-control' }] },
      kycCard: { shareholders: [{ name: 'Jane Smith', type: 'individual' }] },
    };
    const out = await compileScreeningList(state, {});
    const janes = out.screeningSubjects.filter((s) => /jane/i.test(s.name));
    expect(janes.length).toBeLessThanOrEqual(1);
  });

  it('classifies corporate PSC correctly', async () => {
    const state = {
      profile: { company_name: 'ACME LTD' },
      officers: { items: [] },
      psc: { items: [{ name: 'Holding Corp', kind: 'corporate-entity-person-with-significant-control' }] },
      kycCard: { shareholders: [] },
    };
    const out = await compileScreeningList(state, {});
    const corp = out.screeningSubjects.find((s) => s.source === 'psc');
    expect(corp?.kind).toBe('corporate');
  });

  it('uses party-keyed path when partyLinks is populated', async () => {
    const partyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const state = {
      profile: { company_name: 'ACME LTD' },
      kycCard: { identity: { name: 'ACME LTD' } },
      officers: { items: [{ name: 'Jane Smith' }] },
      psc: { items: [] },
      parties: [{ id: partyId, partyType: 'individual', fullName: 'Jane Smith' }],
      partyLinks: [{ partyId, role: 'officer', status: 'active' }],
    };
    const out = await compileScreeningList(state, {});
    const partySubject = out.screeningSubjects.find((s) => s.id === `party:${partyId}`);
    expect(partySubject).toBeTruthy();
    expect(out.fragments.at(-1).outputs.counts).toBeDefined();
  });

  it('skips inactive party links on the party-keyed path', async () => {
    const partyId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const state = {
      profile: { company_name: 'ACME LTD' },
      kycCard: { identity: { name: 'ACME LTD' } },
      officers: { items: [] },
      psc: { items: [] },
      parties: [{ id: partyId, partyType: 'individual', fullName: 'Jane Smith' }],
      partyLinks: [{ partyId, role: 'officer', status: 'historical' }],
    };
    const out = await compileScreeningList(state, {});
    const partySubjects = out.screeningSubjects.filter((s) => s.id?.startsWith('party:'));
    expect(partySubjects).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compileScreeningReport
// ─────────────────────────────────────────────────────────────────────────────
describe('compileScreeningReport', () => {
  it('builds a clean report when there are no hits', async () => {
    const state = {
      screeningSubjects: [{ id: 'profile:acme', name: 'ACME LTD', kind: 'company', source: 'profile' }],
      screeningHits: [],
      screeningEvaluations: [],
    };
    const out = await compileScreeningReport(state, {});
    expect(out.screeningReport.summary.overallRisk).toBe('low');
    expect(out.screeningReport.summary.confirmedHits).toBe(0);
    expect(out.fragments.at(-1).status).toBe('ok');
  });

  it('sets overallRisk to high when a confirmed sanctions hit exists', async () => {
    const state = {
      screeningSubjects: [{ id: 'profile:acme', name: 'ACME LTD', kind: 'company', source: 'profile' }],
      screeningHits: [{ id: 'h1', hitId: 'h1', subjectId: 'profile:acme', listSource: 'ofac_sdn' }],
      screeningEvaluations: [{ hitId: 'h1', decision: 'confirmed', humanOverride: null }],
    };
    const out = await compileScreeningReport(state, {});
    expect(out.screeningReport.summary.overallRisk).toBe('high');
    expect(out.screeningReport.summary.confirmedHits).toBe(1);
  });

  it('sets overallRisk to medium for sanctions needs_review', async () => {
    const state = {
      screeningSubjects: [{ id: 'profile:acme', name: 'ACME LTD', kind: 'company', source: 'profile' }],
      screeningHits: [{ id: 'h2', hitId: 'h2', subjectId: 'profile:acme', listSource: 'uk_hmt' }],
      screeningEvaluations: [{ hitId: 'h2', decision: 'needs_review', humanOverride: null }],
    };
    const out = await compileScreeningReport(state, {});
    expect(out.screeningReport.summary.overallRisk).toBe('medium');
  });

  it('handles empty state gracefully', async () => {
    const out = await compileScreeningReport({}, {});
    expect(out.screeningReport).toBeTruthy();
    expect(out.screeningReport.summary.subjectCount).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qaSkipped
// ─────────────────────────────────────────────────────────────────────────────
describe('qaSkipped', () => {
  it('produces a qaResult with skipped:true and standard_review routing', async () => {
    const out = await qaSkipped({}, {});
    expect(out.qaResult.skipped).toBe(true);
    expect(out.qaResult.routing.caseStatus).toBe('standard_review');
    expect(out.qaResult.passed).toBe(false);
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('lists skipped agents in the qaResult', async () => {
    const state = { agentStatus: { screening: 'skipped', 'risk-assessment': 'skipped' } };
    const out = await qaSkipped(state, {});
    expect(out.qaResult.skippedAgents).toContain('screening');
    expect(out.qaResult.skippedAgents).toContain('risk-assessment');
  });

  it('carries the risk tier through from state', async () => {
    const state = { riskAssessment: { tier: 'Medium' }, agentStatus: {} };
    const out = await qaSkipped(state, {});
    expect(out.qaResult.tier).toBe('Medium');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// entityResolution (pure scoring — uses mocked loadAgentConfig)
// ─────────────────────────────────────────────────────────────────────────────
describe('entityResolution (deterministic scorer)', () => {
  it('auto-matches when top score is decisive', async () => {
    const candidates = [
      { companyNumber: '01234567', title: 'ACME LTD', apiRank: 0, score: 0, postcode: 'EC1A1AA', type: 'ltd' },
      { companyNumber: '09999999', title: 'ACME SUPPLIES LTD', apiRank: 1, score: 0, postcode: null, type: 'ltd' },
    ];
    const input = { companyNumber: '01234567', name: 'Acme Ltd' };
    const out = await entityResolution({ candidates, input }, {});
    expect(out.resolution.status).toBe('auto_match');
    expect(out.resolution.chosen).toBe('01234567');
  });

  it('needs_user_pick when scores are close', async () => {
    const candidates = [
      { companyNumber: '01111111', title: 'ACME LTD', apiRank: 0, score: 0 },
      { companyNumber: '02222222', title: 'ACME TRADING LTD', apiRank: 1, score: 0 },
    ];
    const out = await entityResolution({ candidates, input: { name: 'Acme' } }, {});
    expect(out.resolution.status).toBe('needs_user_pick');
    expect(out.resolution.chosen).toBeUndefined();
  });

  it('returns needs_more_info when candidates is empty', async () => {
    const out = await entityResolution({ candidates: [], input: { name: 'Acme' } }, {});
    expect(out.resolution.status).toBe('needs_more_info');
    expect(out.fragments.at(-1).status).toBe('failed');
  });

  it('skips when upstream set resolution to not_found', async () => {
    const out = await entityResolution({
      candidates: [],
      input: { name: 'Acme' },
      resolution: { status: 'not_found' },
    }, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('boosts score for exact company number match', async () => {
    const candidates = [
      { companyNumber: '01234567', title: 'ACME LTD', apiRank: 5, score: 0 },
    ];
    const input = { companyNumber: '01234567' };
    const out = await entityResolution({ candidates, input }, {});
    const top = out.candidates[0];
    expect(top.scoreBreakdown.numberMatch).toBe(1.0);
  });

  it('caps returned candidates at maxCandidates', async () => {
    const candidates = Array.from({ length: 10 }, (_, i) => ({
      companyNumber: `0${i}000000`,
      title: `ACME ${i}`,
      apiRank: i,
      score: 0,
    }));
    const out = await entityResolution({ candidates, input: { name: 'Acme' } }, {});
    expect(out.candidates.length).toBeLessThanOrEqual(5);
  });
});
