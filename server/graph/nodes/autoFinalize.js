// Phase 5 follow-up — auto_finalize graph node.
//
// Runs after qa_check when QA routes the case to `auto_approved`. Calls
// applyDecision with a system userId so the dossier moves straight to
// case_status='approved' and an immutable audit fragment is written —
// no human pause, no await_decision interrupt, no run sitting in 'running'
// forever.
//
// Mirrors the apply-then-resume contract of await_decision except there is
// no interrupt and no resume: the DB write is the whole effect, the node
// just emits a trace event and returns.

const { traceEvent, errorEvent } = require('../state');
const { applyDecision } = require('../../services/decision');
const { ensureRunIdentity } = require('./_identity');
const { log } = require('../../services/log');

const SYSTEM_USER_ID = 'system';

async function autoFinalize(state, config) {
  const companyNumber = state.companyNumber;
  // R4a — resolve identity via the shared helper (state channel → config →
  // DB-by-thread_id). resolve_parties already wrote the ids into state on the
  // happy path, so this is normally the cheap branch.
  let dossierId = null;
  let runId = null;
  try {
    ({ dossierId, runId } = await ensureRunIdentity(state, config));
  } catch (err) {
    // Fall through to the missing-identifiers branch below.
    log.error(`[auto_finalize] ensureRunIdentity failed: ${err.message}`);
  }

  if (!companyNumber || !runId) {
    const threadId = config?.configurable?.thread_id || config?.configurable?.threadId || null;
    return {
      errors: [
        errorEvent(
          'auto_finalize',
          `missing companyNumber or runId (cn=${companyNumber}, runId=${runId}, threadId=${threadId})`,
        ),
      ],
      trace: [traceEvent('auto_finalize', 'skipped — missing identifiers')],
    };
  }

  try {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: SYSTEM_USER_ID,
      payload: { action: 'approve', userId: SYSTEM_USER_ID },
    });
    return {
      dossierId,
      runId,
      trace: [
        traceEvent('auto_finalize', 'auto-approved by system', {
          caseStatus: result.caseStatus,
          fragmentId: result.fragmentId,
        }),
      ],
    };
  } catch (err) {
    // invalid_transition (case already finalised) is the only realistic miss:
    // a re-run of an already-approved dossier. Trace it and continue so the
    // run still closes cleanly.
    return {
      errors: [errorEvent('auto_finalize', err.message || String(err))],
      trace: [
        traceEvent('auto_finalize', 'applyDecision failed', {
          code: err.code || null,
          message: err.message || null,
        }),
      ],
    };
  }
}

module.exports = { autoFinalize };
