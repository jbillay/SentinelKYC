// Phase 5 / Q2 — completeness check.
//
// Pure. Verifies the projected case has every field required to make a
// review decision. PEP coverage is explicitly N/A in v1 (CLAUDE.md screening
// scope) — sanctions + adverse-media presence is what counts as a satisfied
// screening_results.
//
// Returns { passed, missing, warnings }.
//   - `missing` — top-level missing codes that gate completeness.
//   - `warnings` — soft signals (e.g. a single failed document extraction)
//     that don't fail the check but get surfaced in highlightedIssues.

function checkCompleteness(projection = {}) {
  const missing = [];
  const warnings = [];

  if (!projection.registry_record) {
    missing.push('registry_record');
  }

  if (!Array.isArray(projection.ubo_list) || projection.ubo_list.length === 0) {
    missing.push('ubo_list_empty');
  }

  if (!projection.screening_results) {
    missing.push('screening_results');
  }

  if (projection.risk_score === null || projection.risk_score === undefined) {
    missing.push('risk_score');
  }

  if (!projection.risk_narrative || String(projection.risk_narrative).trim() === '') {
    missing.push('risk_narrative');
  }

  // Document failures are warnings, not gating. Completeness still passes —
  // the UI surfaces these via highlightedIssues so the reviewer can decide.
  for (const d of projection.document_status || []) {
    if (d && d.status === 'failed') {
      warnings.push(`document_status:${d.category}:failed`);
    }
  }

  return {
    passed: missing.length === 0,
    missing,
    warnings,
  };
}

module.exports = {
  checkCompleteness,
};
