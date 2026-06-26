// S8 (batch 2) — Pure-path unit tests for the graph/nodes files the first S8
// batch left uncovered: the two per-hit screening evaluators, the adverse-media
// screening node, qa_check, await_decision and process_documents.
//
// HARNESS LIMITATION (the boundary this file deliberately respects):
//   In the default forks pool, vitest only routes module loading through its
//   own (mockable) runner for packages named in vitest.config.mjs deps.inline
//   (the LangGraph set). Every other dependency — db/repo, services/llm,
//   services/adverseMedia, the per-hit LLM evaluator cores — is loaded by
//   Node's NATIVE CJS require from inside the graph-node files, so a vi.mock()
//   against them is a no-op. We verified this empirically: a vi.mock'd
//   adverseMedia.search still issued a live GDELT request.
//
//   Consequence: the LLM-judgement loops, dossier/party override precedence
//   and per-subject GDELT fetch CANNOT be unit-tested offline here — they would
//   hit the real model / network / DB. Those paths stay in the integration +
//   smoke tier (graph-nodes-llm.int.test.mjs, *-smoke.js). This is the same
//   "needs a DI refactor to be testable offline" boundary called out in the S1
//   suite header.
//
//   So this file tests only the DETERMINISTIC, no-I/O surface of each node:
//   the empty/skip guards, the pure delegation in qa_check (the QA engine is
//   pure; loadActiveMatrix has a no-DB bundled-defaults fallback), the
//   interrupt hand-off contract in await_decision, and process_documents'
//   page-selection + empty-batch guard.
//
// LangGraph still has to load (graph/fragments.js → isGraphInterrupt; the node
// state schema → @langchain/langgraph/zod): deps.inline transforms it. We load
// the nodes via dynamic import() in beforeAll so that transform runs inside the
// vitest runner. The first import pays the cold transform cost, hence the 60s
// hook timeout (the default 10s flakes on an isolated run).

import { describe, it, expect, beforeAll } from 'vitest';

let evaluateSanctionsHits, evaluateAdverseMedia, screenAdverseMedia;
let qaCheck, awaitDecision, ACTION_TO_CASE_STATUS, processDocuments, _selectOcrPages;

beforeAll(async () => {
  ({ evaluateSanctionsHits } = await import('../graph/nodes/screening/evaluateSanctionsHits.js'));
  ({ evaluateAdverseMedia } = await import('../graph/nodes/screening/evaluateAdverseMedia.js'));
  ({ screenAdverseMedia } = await import('../graph/nodes/screening/screenAdverseMedia.js'));
  ({ qaCheck } = await import('../graph/nodes/qaCheck.js'));
  ({ awaitDecision, ACTION_TO_CASE_STATUS } = await import('../graph/nodes/awaitDecision.js'));
  ({ processDocuments, _selectOcrPages } = await import('../graph/nodes/processDocuments.js'));
}, 60000);

// ─────────────────────────────────────────────────────────────────────────────
// evaluate_sanctions_hits — empty/skip guard (the only branch reachable without
// the LLM evaluator core, which native-require bypasses vi.mock).
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateSanctionsHits — guards', () => {
  it('skips when there are no screening hits', async () => {
    const out = await evaluateSanctionsHits({ screeningHits: [], screeningSubjects: [] }, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
    expect(out.fragments.at(-1).inputs.hitCount).toBe(0);
    expect(out.screeningEvaluations).toBeUndefined();
  });

  it('skips when only adverse-media hits are present (sanctions node ignores them)', async () => {
    const out = await evaluateSanctionsHits(
      {
        screeningHits: [{ hitId: 'a1', subjectId: 's1', listSource: 'adverse_media' }],
        screeningSubjects: [],
      },
      {},
    );
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('handles a missing screeningHits channel without throwing', async () => {
    const out = await evaluateSanctionsHits({}, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// evaluate_adverse_media — empty/skip guard.
// ─────────────────────────────────────────────────────────────────────────────
describe('evaluateAdverseMedia — guards', () => {
  it('skips when there are no adverse-media hits', async () => {
    const out = await evaluateAdverseMedia(
      {
        screeningHits: [{ hitId: 'h1', subjectId: 's1', listSource: 'ofac_sdn' }],
        screeningSubjects: [],
      },
      {},
    );
    expect(out.fragments.at(-1).status).toBe('skipped');
    expect(out.fragments.at(-1).inputs.hitCount).toBe(0);
    expect(out.screeningEvaluations).toBeUndefined();
  });

  it('handles a missing screeningHits channel without throwing', async () => {
    const out = await evaluateAdverseMedia({}, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// screen_adverse_media — the "nothing to fetch" guards short-circuit BEFORE any
// GDELT call, so they're deterministic. (The actual fetch path hits the live
// network and is covered by the smoke tier.) Companies are filtered out — a
// company-only subject list yields zero individuals → skipped. We assert only
// the skip outcome so the test is robust whether the agent config has adverse
// media enabled (→ skipped: no individuals) or disabled (→ skipped: off).
// ─────────────────────────────────────────────────────────────────────────────
describe('screenAdverseMedia — no-individual guards', () => {
  it('skips when the subject list is empty', async () => {
    const out = await screenAdverseMedia({ screeningSubjects: [] }, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
    expect(out.screeningHits).toBeUndefined();
  });

  it('skips when every subject is a company (companies are not adverse-media screened)', async () => {
    const out = await screenAdverseMedia(
      {
        screeningSubjects: [
          { id: 'c1', name: 'ACME LTD', kind: 'company', source: 'profile' },
          { id: 'c2', name: 'HOLDCO LTD', kind: 'corporate', source: 'psc' },
        ],
      },
      {},
    );
    expect(out.fragments.at(-1).status).toBe('skipped');
    expect(out.screeningHits).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qa_check — delegates to the pure QA engine. loadActiveMatrix falls back to
// bundled defaults without a DB, and evaluateQa ignores the matrix anyway, so
// the routing outcome is a deterministic function of the input state.
// ─────────────────────────────────────────────────────────────────────────────
describe('qaCheck — routing via the pure QA engine', () => {
  const passingLowState = {
    profile: { company_name: 'ACME LTD', company_status: 'active' },
    psc: { items: [{ name: 'John Smith', kind: 'individual-person-with-significant-control' }] },
    kycCard: { identity: { name: 'ACME LTD', status: 'active' }, shareholders: [] },
    screeningReport: {
      summary: { overallRisk: 'low', confirmedHits: 0 },
      perSubject: [{ name: 'John Smith' }],
    },
    riskAssessment: { score: 20, tier: 'Low', rationale: 'Low-risk profile.', knockoutsTriggered: [] },
  };

  it('routes a complete, clean Low-risk case to auto_approved', async () => {
    const out = await qaCheck(passingLowState, {});
    expect(out.qaResult.passed).toBe(true);
    expect(out.qaResult.routing.caseStatus).toBe('auto_approved');
    expect(out.qaResult.tier).toBe('Low');
    expect(out.fragments.at(-1).status).toBe('ok');
    expect(out.fragments.at(-1).kind).toBe('decision');
  });

  it('routes an incomplete case to standard_review with a failed fragment', async () => {
    const out = await qaCheck({}, {});
    expect(out.qaResult.passed).toBe(false);
    expect(out.qaResult.routing.caseStatus).toBe('standard_review');
    expect(out.qaResult.completeness.missing).toContain('registry_record');
    expect(out.fragments.at(-1).status).toBe('failed');
  });

  it('fails completeness when a confirmed sanction hit is present but tier stays Low', async () => {
    // consistency: tier_too_low_for_sanction_hit. confirmedHits>0 but tier!=High.
    const state = {
      ...passingLowState,
      screeningReport: {
        summary: { overallRisk: 'low', confirmedHits: 1 },
        perSubject: [{ name: 'John Smith' }],
      },
    };
    const out = await qaCheck(state, {});
    expect(out.qaResult.passed).toBe(false);
    expect(out.qaResult.consistency.issues.map((i) => i.code))
      .toContain('tier_too_low_for_sanction_hit');
    expect(out.qaResult.routing.caseStatus).toBe('standard_review');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// await_decision — interrupt() hand-off contract. The real interrupt() (loaded
// via deps.inline) throws GraphInterrupt outside a graph, so the reviewer-resume
// branch can't be exercised offline; we assert the guards + that a non-terminal
// run reaches and re-throws from interrupt. The terminal short-circuit needs a
// DB returning an already-finalised dossier — covered in the integration tier.
// ─────────────────────────────────────────────────────────────────────────────
describe('awaitDecision — guards and interrupt hand-off', () => {
  it('exposes the action → case_status map', () => {
    expect(ACTION_TO_CASE_STATUS.approve).toBe('approved');
    expect(ACTION_TO_CASE_STATUS.reject).toBe('rejected');
    expect(ACTION_TO_CASE_STATUS.escalate).toBe('escalated');
    expect(ACTION_TO_CASE_STATUS.request_info).toBe('info_requested');
  });

  it('reaches interrupt() and re-throws GraphInterrupt for a non-terminal run', async () => {
    // No companyNumber → dossier lookup is skipped, dossierCaseStatus stays null
    // (non-terminal), so the node hands off to interrupt(), which throws outside
    // a graph. The throw confirms the guards passed and the pause was attempted.
    await expect(
      awaitDecision({ qaResult: {}, riskAssessment: {}, kycCard: {} }),
    ).rejects.toThrow();
  });

  it('swallows a dossier lookup failure and still hands off to interrupt', async () => {
    // With a companyNumber and no reachable DB, repo.getDossier throws; the node
    // logs and falls through to interrupt() rather than aborting — so it still
    // throws GraphInterrupt rather than the lookup error.
    await expect(awaitDecision({ companyNumber: '01234567' })).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// process_documents — empty-batch guard + the pure page-selection helper.
// _selectOcrPages' first-N branch (no relevance keywords, or page count within
// the cap) needs no PDF I/O. The relevance branch reads the PDF text layer and
// is covered by extraction-truncation-smoke.
// ─────────────────────────────────────────────────────────────────────────────
describe('processDocuments — guard + page selection', () => {
  it('skips when there are no documents', async () => {
    const out = await processDocuments({ documents: [] }, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
    expect(out.documents).toBeUndefined();
  });

  it('handles a missing documents channel without throwing', async () => {
    const out = await processDocuments({}, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('_selectOcrPages returns first-N reading-order pages for a no-keyword category', async () => {
    // incorporation has no RELEVANCE_KEYWORDS → always first-N, regardless of
    // the configured cap. Assert the contiguous-from-1 prefix shape.
    const { pages, selectionMode } = await _selectOcrPages(
      { category: 'incorporation', path: '/nonexistent.pdf' },
      3,
    );
    expect(selectionMode).toBe('first');
    expect(pages[0]).toBe(1);
    expect(pages).toEqual([...pages].sort((a, b) => a - b)); // reading order
    expect(pages.length).toBeLessThanOrEqual(3);
  });

  it('_selectOcrPages takes first-N when page count is within the cap', async () => {
    // confirmation-statement HAS keywords, but pageCount (2) ≤ cap (default 5)
    // short-circuits to first-N before any text-layer read.
    const { pages, selectionMode } = await _selectOcrPages(
      { category: 'confirmation-statement', path: '/nonexistent.pdf' },
      2,
    );
    expect(selectionMode).toBe('first');
    expect(pages).toEqual([1, 2]);
  });
});
