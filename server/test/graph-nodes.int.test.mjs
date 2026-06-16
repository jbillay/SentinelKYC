// Phase 4 — graph nodes whose only I/O is a DB-backed config read
// (entityResolution → loadAgentConfig; qaCheck → loadActiveMatrix). vi.mock
// does NOT intercept the CJS require inside these node modules, so rather than
// fake the dep we run the node against the REAL seeded config in the test
// Postgres — deterministic, and it exercises the node + its engine for real.
// Registry/LLM-bound nodes (searchCh, fetchApis, synthesizeCard, screening,
// qaNarrative) need a DI refactor to be testable offline and are deferred.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { describeIntegration, seedReference, closePool } from './helpers/appHarness.mjs';

const require = createRequire(import.meta.url);

describeIntegration('graph nodes (DB-config backed)', () => {
  let entityResolution;
  let qaCheck;
  beforeAll(async () => {
    await seedReference(); // agent config + risk matrix in the test DB
    ({ entityResolution } = require('../graph/nodes/entityResolution.js'));
    ({ qaCheck } = require('../graph/nodes/qaCheck.js'));
  }, 30_000);
  afterAll(closePool);

  const cand = (over) => ({ companyNumber: '00000000', title: 'ACME LTD', apiRank: 0, score: 0, ...over });

  it('entityResolution: needs_more_info with no candidates', async () => {
    const out = await entityResolution({ candidates: [], input: {} }, {});
    expect(out.resolution.status).toBe('needs_more_info');
    expect(out.fragments[0].status).toBe('failed');
  });

  it('entityResolution: skips when upstream marked not_found', async () => {
    const out = await entityResolution({ resolution: { status: 'not_found' }, candidates: [] }, {});
    expect(out.fragments[0].status).toBe('skipped');
  });

  it('entityResolution: auto-matches on a hard company-number match (seeded threshold 0.85)', async () => {
    const out = await entityResolution({
      input: { companyNumber: '01234567' },
      candidates: [cand({ companyNumber: '01234567', apiRank: 0 }), cand({ companyNumber: '09999999', apiRank: 5 })],
    }, {});
    expect(out.resolution.status).toBe('auto_match');
    expect(out.resolution.chosen).toBe('01234567');
  });

  it('entityResolution: needs_user_pick when the top two are close', async () => {
    const out = await entityResolution({
      input: { name: 'ACME' },
      candidates: [cand({ companyNumber: '1', apiRank: 0 }), cand({ companyNumber: '2', apiRank: 1 })],
    }, {});
    expect(out.resolution.status).toBe('needs_user_pick');
  });

  it('entityResolution: scores postcode + year + type-keyword bonuses', async () => {
    const out = await entityResolution({
      input: { name: 'ACME LIMITED', postcode: 'EC1A 1AA', incorporationYear: 2010 },
      candidates: [cand({ companyNumber: '1', apiRank: 3, title: 'ACME LIMITED', postcode: 'ec1a1aa', incorporationDate: '2010-06-01' })],
    }, {});
    const bd = out.fragments[0].outputs.scoreBreakdown;
    expect(bd).toMatchObject({ postcodeMatch: 0.3, yearMatch: 0.2, typeMatch: 0.15 });
  });

  const LOW_RISK_STATE = {
    profile: { company_status: 'active' },
    psc: { items: [{ name: 'Jane Holder', kind: 'individual-person-with-significant-control' }] },
    kycCard: {
      identity: { name: 'ACME LTD', companyNumber: '01234567', status: 'active' },
      shareholders: [{ name: 'Jane Holder', type: 'individual' }],
    },
    screeningReport: {
      summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' },
      perSubject: [{ name: 'Jane Holder', partyId: null }],
    },
    riskAssessment: { score: 12, tier: 'Low', rationale: 'Low.', knockoutsTriggered: [] },
    documents: [],
  };

  it('qaCheck: writes qaResult and routes a clean Low case to auto_approved', async () => {
    const out = await qaCheck(LOW_RISK_STATE, {});
    expect(out.qaResult.passed).toBe(true);
    expect(out.qaResult.routing.caseStatus).toBe('auto_approved');
    expect(out.fragments[0]).toMatchObject({ nodeId: 'qa_check', kind: 'decision', status: 'ok' });
  });

  it('qaCheck: marks the fragment failed (routing signal) when QA does not pass', async () => {
    const out = await qaCheck({ ...LOW_RISK_STATE, profile: undefined }, {});
    expect(out.qaResult.passed).toBe(false);
    expect(out.fragments[0].status).toBe('failed');
  });
});
