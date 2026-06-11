// Phase 5 / Q4 — applyDecision.
//
// Single transactional flow that asserts the case is in a non-terminal state
// (and, for approve, in a QA-routed state), flips dossiers.case_status, and
// writes an immutable audit fragment with kind='human_action'. The fragment
// is the audit trail — never overwritten, never deleted.
//
// Throws with `code = 'invalid_transition'` for forbidden transitions and
// `code = 'not_found'` for missing dossier/run. Callers map these to HTTP
// 409 / 404 respectively.

const { eq, sql } = require('drizzle-orm');
const { db } = require('../../db/client');
const { dossiers, runs, decisionFragments } = require('../../db/schema');

// Allowed-from sets. Updated for the await_decision interrupt: case_status
// stays 'pending' through QA (the QA routing tier no longer mirrors to the
// dossier), so 'pending' is now a valid entry point for every action and
// 'auto_approved' / 'streamlined_review' / 'standard_review' are only ever
// seen on legacy dossiers that were finalised before the interrupt landed.
const ALLOWED_FROM_ANY = new Set([
  'pending',
  'auto_approved',
  'streamlined_review',
  'standard_review',
  'info_requested',
  'escalated',
]);
const ALLOWED_FROM_APPROVE = new Set([
  'pending',
  'auto_approved',
  'streamlined_review',
  'standard_review',
]);

const ACTION_TO_NEXT_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  escalate: 'escalated',
  request_info: 'info_requested',
};

function transitionError(from, action) {
  const err = new Error(`Invalid transition: cannot ${action} from ${from}`);
  err.code = 'invalid_transition';
  err.from = from;
  err.action = action;
  return err;
}

function notFound(message) {
  const err = new Error(message);
  err.code = 'not_found';
  return err;
}

function buildSummary(userId, payload) {
  switch (payload.action) {
    case 'approve':
      return `User ${userId} approved case`;
    case 'reject':
      return `User ${userId} rejected case (${payload.reasonCode})`;
    case 'escalate':
      return `User ${userId} escalated case`;
    case 'request_info':
      return `User ${userId} requested info (${payload.items.length} item${payload.items.length === 1 ? '' : 's'})`;
    default:
      return `User ${userId} took action: ${payload.action}`;
  }
}

function actionMetadata(payload) {
  // Strip userId — it's carried separately on inputs.
  const { userId: _userId, action: _action, ...rest } = payload;
  return rest;
}

// R4b: `resumeOwed: true` (the /decision route path) stamps
// runs.resume_owed_at inside the SAME transaction, making "decision applied ⇒
// resume owed" atomic. auto_finalize leaves it false — there is no paused
// thread to resume in that path.
async function applyDecision({ companyNumber, runId, userId, payload, resumeOwed = false }) {
  if (!companyNumber) throw notFound('companyNumber required');
  if (!runId) throw notFound('runId required');
  if (!userId) throw new Error('userId required');
  if (!payload || !payload.action) throw new Error('payload.action required');

  const nextStatus = ACTION_TO_NEXT_STATUS[payload.action];
  if (!nextStatus) {
    const err = new Error(`Unknown action: ${payload.action}`);
    err.code = 'invalid_payload';
    throw err;
  }

  // decision_fragments has UNIQUE (run_id, sequence) — migration 0010. The
  // sequence read below is not FOR UPDATE, so a graph fragment landing between
  // the max() read and the insert (or a concurrent decision) surfaces as a
  // 23505 on that constraint. Retry the whole transaction once with a fresh
  // max() rather than losing the reviewer's decision to a 500.
  // See CODE_REVIEW §4.2.
  try {
    return await applyDecisionTxn({ companyNumber, runId, userId, payload, resumeOwed, nextStatus });
  } catch (err) {
    if (err?.code === '23505' && /decision_fragments_run_sequence_unique/.test(err?.message || err?.detail || '')) {
      return applyDecisionTxn({ companyNumber, runId, userId, payload, resumeOwed, nextStatus });
    }
    throw err;
  }
}

async function applyDecisionTxn({ companyNumber, runId, userId, payload, resumeOwed, nextStatus }) {
  return db.transaction(async (tx) => {
    const [dossier] = await tx
      .select()
      .from(dossiers)
      .where(eq(dossiers.companyNumber, companyNumber))
      .limit(1);
    if (!dossier) throw notFound('dossier not found');

    const [run] = await tx.select().from(runs).where(eq(runs.id, runId)).limit(1);
    if (!run) throw notFound('run not found');
    if (run.dossierId !== dossier.id) {
      throw notFound('run does not belong to dossier');
    }

    const from = dossier.caseStatus;
    if (!ALLOWED_FROM_ANY.has(from)) {
      throw transitionError(from, payload.action);
    }
    if (payload.action === 'approve' && !ALLOWED_FROM_APPROVE.has(from)) {
      throw transitionError(from, payload.action);
    }

    await tx
      .update(dossiers)
      .set({
        caseStatus: nextStatus,
        caseStatusUpdatedAt: sql`now()`,
        caseStatusRunId: runId,
        updatedAt: sql`now()`,
      })
      .where(eq(dossiers.id, dossier.id));

    // Next per-run sequence number for the fragment. The read is not
    // SELECT…FOR UPDATE; a collision surfaces as 23505 on the
    // decision_fragments_run_sequence_unique constraint (migration 0010) and
    // applyDecision retries the transaction once with a fresh max().
    const seqRow = await tx.execute(sql`
      select coalesce(max(sequence), -1) + 1 as next
      from decision_fragments
      where run_id = ${runId}
    `);
    const sequence = Number(seqRow.rows?.[0]?.next ?? 0);

    const summary = buildSummary(userId, payload);
    const metadata = actionMetadata(payload);

    const [fragment] = await tx
      .insert(decisionFragments)
      .values({
        runId,
        parentFragmentId: null,
        nodeId: 'human_decision',
        sequence,
        kind: 'human_action',
        status: 'ok',
        startedAt: sql`now()`,
        durationMs: 0,
        summary,
        inputs: { userId, action: payload.action, runId },
        outputs: { ...metadata, timestamp: new Date().toISOString() },
      })
      .returning();

    if (resumeOwed) {
      await tx.update(runs).set({ resumeOwedAt: sql`now()` }).where(eq(runs.id, runId));
    }

    return {
      ok: true,
      caseStatus: nextStatus,
      fragmentId: fragment.id,
      previousCaseStatus: from,
    };
  });
}

module.exports = {
  applyDecision,
  ALLOWED_FROM_ANY,
  ALLOWED_FROM_APPROVE,
  ACTION_TO_NEXT_STATUS,
};
