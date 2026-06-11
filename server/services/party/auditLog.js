// Phase 1a — KYC-replay audit log for the party matcher.
//
// Every call to PartyMatchService.findMatches (regardless of source —
// HTTP route or in-graph resolve_parties node, in Phase 1b) writes one row
// into party_match_log via recordMatchCall. Zero-match calls are recorded
// too: an auditor must be able to reconstruct exactly which inputs the
// system has seen, what it returned, and who triggered it.
//
// Why a separate table instead of reusing decision_fragments:
//   * decision_fragments is per-graph-node grain. resolve_parties produces
//     ONE fragment per run summarising "N inputs, M auto-linked, K queued"
//     — too coarse for replaying an individual match decision.
//   * party_match_log is per-call grain. One row per findMatches invocation.
//   * The HTTP route doesn't run inside the graph at all — it has no
//     fragment context to attach to.
//   * Retention policies will differ: graph fragments are cleaned with
//     their runs; the match log lives as long as the parties it audits.

const repo = require('../../db/repo');
const { log } = require('../log');

// Persist one match invocation. Never throws into the caller — audit
// failures are logged but don't break the user-facing match response.
// (A second-line BEFORE-INSERT trigger or a separate alerting hook would
// be the production answer for "audit MUST succeed"; for the POC, console
// + visibility via the existing 500 path is sufficient.)
async function recordMatchCall({
  inputName,
  inputCanonical,
  candidates,
  topScore = null,
  calledBy,
  source = 'api',
}) {
  if (typeof inputName !== 'string') {
    throw new TypeError('recordMatchCall: inputName must be a string');
  }
  if (typeof calledBy !== 'string' || !calledBy) {
    throw new TypeError('recordMatchCall: calledBy required');
  }
  if (source !== 'api' && source !== 'resolver') {
    throw new TypeError(`recordMatchCall: source must be 'api' | 'resolver', got ${source}`);
  }

  // Compact candidate projection — full party rows can be re-fetched via
  // partyId. We persist only what's needed for replay: which parties came
  // back, with what score and confidence label.
  const compact = (candidates || []).map((c) => ({
    partyId: c.partyId,
    score: c.score,
    confidence: c.confidence,
    matchedVia: c.matchedVia,
  }));

  try {
    return await repo.insertPartyMatchLog({
      inputName,
      inputCanonical: inputCanonical || '',
      candidates: compact,
      matchCount: compact.length,
      topScore,
      calledBy,
      source,
    });
  } catch (err) {
    // Make the failure visible without breaking the caller's response. The
    // POC has no alerting layer; in production this would be the place to
    // push a metric / page on it.
    log.error(`[party_match_log] insert failed: ${err.message}`);
    return null;
  }
}

module.exports = { recordMatchCall };
