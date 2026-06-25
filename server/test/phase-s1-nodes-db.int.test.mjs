// Phase S1 (integration) — graph nodes that touch the DB.
//
// Covers qaCheck (loads active risk matrix from DB), entityResolution (loads
// agent config from DB), and autoFinalize (applyDecision + ensureRunIdentity).
//
// All LLM paths are either absent (qaCheck/entityResolution are pure after
// DB load) or irrelevant (autoFinalize never calls the LLM). The OLLAMA_HOST
// set by the harness to a dead port means any accidental LLM call fails fast.
//
// Needs TEST_DATABASE_URL. Without it the suite is skipped automatically.

import { it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import {
  describeIntegration,
  seedReference,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

const require = createRequire(import.meta.url);

// ─── qaCheck ─────────────────────────────────────────────────────────────────

describeIntegration('qaCheck (DB — loads active matrix)', () => {
  let qaCheck;

  beforeAll(async () => {
    await seedReference();
    ({ qaCheck } = require('../graph/nodes/qaCheck.js'));
  }, 30_000);

  afterAll(closePool);

  const BASE_STATE = {
    companyNumber: '01234567',
    profile: {
      company_status: 'active',
      type: 'ltd',
      registered_office_address: { country: 'United Kingdom' },
    },
    kycCard: {
      identity: { name: 'ACME LTD', status: 'active', countryOfIncorporation: 'United Kingdom' },
      officers: [{ name: 'Jane Smith', role: 'director', active: true }],
      shareholders: [{ name: 'Jane Smith', type: 'individual', percentage: 100 }],
    },
    officers: { items: [{ name: 'Jane Smith', officer_role: 'director', resigned_on: null }] },
    psc: { items: [{ name: 'Jane Smith', kind: 'individual-person-with-significant-control' }] },
    screeningReport: {
      summary: {
        subjectCount: 2,
        confirmedHits: 0,
        needsReview: 0,
        dismissedHits: 0,
        overallRisk: 'low',
      },
    },
    riskAssessment: { score: 10, tier: 'Low', outcome: 'Approve' },
    parties: [],
    partyLinks: [],
    agentStatus: {},
  };

  it('produces a qaResult with routing', async () => {
    const out = await qaCheck(BASE_STATE, { configurable: { runId: 'qa-db-1' } });
    expect(out.qaResult).toBeTruthy();
    expect(out.qaResult.routing?.caseStatus).toBeTruthy();
    expect(['auto_approved', 'streamlined_review', 'standard_review']).toContain(
      out.qaResult.routing.caseStatus,
    );
  });

  it('emits a fragment with ok or failed status', async () => {
    const out = await qaCheck(BASE_STATE, { configurable: { runId: 'qa-db-2' } });
    const frag = out.fragments?.at(-1);
    expect(frag).toBeTruthy();
    expect(['ok', 'failed']).toContain(frag.status);
  });

  it('routes to auto_approved when risk is Low and QA passes', async () => {
    const out = await qaCheck(BASE_STATE, { configurable: { runId: 'qa-db-3' } });
    if (out.qaResult.passed) {
      expect(out.qaResult.routing.caseStatus).toBe('auto_approved');
    } else {
      // QA failed → standard_review is correct
      expect(out.qaResult.routing.caseStatus).toBe('standard_review');
    }
  });

  it('routes to standard_review when risk is High', async () => {
    const highState = {
      ...BASE_STATE,
      riskAssessment: { score: 80, tier: 'High', outcome: 'Reject' },
      screeningReport: {
        summary: {
          subjectCount: 2,
          confirmedHits: 1,
          needsReview: 0,
          dismissedHits: 0,
          overallRisk: 'high',
        },
      },
    };
    const out = await qaCheck(highState, { configurable: { runId: 'qa-db-4' } });
    expect(out.qaResult.routing.caseStatus).toBe('standard_review');
  });

  it('fragment inputs carry risk snapshot', async () => {
    const out = await qaCheck(BASE_STATE, { configurable: { runId: 'qa-db-5' } });
    const frag = out.fragments?.at(-1);
    expect(frag?.inputs?.riskTier).toBe('Low');
    expect(typeof frag?.inputs?.riskScore).toBe('number');
  });
});

// ─── entityResolution (agent config from DB) ──────────────────────────────────

describeIntegration('entityResolution (DB — loads agent config)', () => {
  let entityResolution;

  beforeAll(async () => {
    await seedReference();
    ({ entityResolution } = require('../graph/nodes/entityResolution.js'));
  }, 30_000);

  afterAll(closePool);

  it('needs_more_info when candidates is empty', async () => {
    const out = await entityResolution({ candidates: [] }, { configurable: {} });
    expect(out.resolution?.status).toBe('needs_more_info');
  });

  it('needs_user_pick when top score < 0.85', async () => {
    const candidates = [
      { companyNumber: '00000001', title: 'WIDGET CO LTD', dateOfCreation: '2010-01-01', apiRank: 0 },
      { companyNumber: '00000002', title: 'WIDGETS INC', dateOfCreation: '2012-01-01', apiRank: 1 },
    ];
    const out = await entityResolution(
      { candidates, input: { name: 'Completely Different Name' } },
      { configurable: {} },
    );
    expect(out.resolution?.status).toBe('needs_user_pick');
  });

  it('emits a trace event', async () => {
    const out = await entityResolution({ candidates: [] }, { configurable: {} });
    expect(Array.isArray(out.trace)).toBe(true);
    expect(out.trace.length).toBeGreaterThan(0);
  });

  it('auto_match when single candidate has company number matching input', async () => {
    const cn = '01234567';
    const candidates = [
      {
        companyNumber: cn,
        title: 'ACME LTD',
        dateOfCreation: '2015-06-01',
        address: {},
        apiRank: 0,
      },
    ];
    const out = await entityResolution(
      { candidates, input: { companyNumber: cn } },
      { configurable: {} },
    );
    // Company-number exact match (+1.0) plus base (1.0) → score 2.0 ≥ threshold → auto_match
    expect(out.resolution?.status).toBe('auto_match');
  });
});

// ─── autoFinalize (missing identifiers path — no real dossier needed) ─────────

describeIntegration('autoFinalize (DB — missing identifier guard)', () => {
  let autoFinalize;

  beforeAll(async () => {
    await seedReference();
    ({ autoFinalize } = require('../graph/nodes/autoFinalize.js'));
  }, 30_000);

  afterAll(closePool);

  it('returns an error trace when companyNumber is missing', async () => {
    const out = await autoFinalize({}, { configurable: { thread_id: 'test-af-1' } });
    const errEvent = out.errors?.[0];
    expect(errEvent).toBeTruthy();
    expect(errEvent.msg || errEvent.message || '').toMatch(/missing/i);
  });

  it('returns an error trace when runId cannot be resolved', async () => {
    // No real run in DB; ensureRunIdentity will fail → missing-identifiers path
    const out = await autoFinalize(
      { companyNumber: '99999999' },
      { configurable: { thread_id: 'test-af-nonexistent' } },
    );
    const errEvent = out.errors?.[0];
    expect(errEvent).toBeTruthy();
  });

  it('includes a trace event regardless of error', async () => {
    const out = await autoFinalize({}, { configurable: { thread_id: 'test-af-3' } });
    expect(Array.isArray(out.trace)).toBe(true);
    expect(out.trace.length).toBeGreaterThan(0);
  });
});
