// R4a — run-identity resolution helper.
//
// LangGraph snapshots `configurable` at stream start, so the SSE runtime's
// later mutation of configurable.dossierId/runId (done at the lazy dossier+run
// upsert) doesn't reach nodes that run post-interrupt. Several nodes therefore
// re-resolved identity from the DB by thread_id — copy-pasted in
// resolveParties.js and autoFinalize.js. This helper centralises that exact
// logic with a cheap-first preference order:
//
//   state.dossierId / state.runId      (R4a channels — populated write-through
//                                       by the first caller's partial state)
//   → config.configurable.{dossierId,runId}
//   → repo.getRunByThreadId(thread_id) (survives configurable snapshotting)
//   → repo.getDossier(state.companyNumber)  (dossierId only — very early runs)
//
// Callers should spread the returned ids into their partial state so every
// downstream node hits the state branch:  return { dossierId, runId, ... }.

const repo = require('../../db/repo');

async function ensureRunIdentity(state, config) {
  let dossierId = state?.dossierId ?? config?.configurable?.dossierId ?? null;
  let runId = state?.runId ?? config?.configurable?.runId ?? null;

  if (!dossierId || !runId) {
    const threadId = config?.configurable?.thread_id ?? config?.configurable?.threadId ?? null;
    if (threadId) {
      const run = await repo.getRunByThreadId(threadId);
      if (run) {
        if (!dossierId) dossierId = run.dossierId;
        if (!runId) runId = run.id;
      }
    }
  }
  if (!dossierId && state?.companyNumber) {
    const dossier = await repo.getDossier(state.companyNumber);
    if (dossier?.id) dossierId = dossier.id;
  }

  return { dossierId, runId };
}

module.exports = { ensureRunIdentity };
