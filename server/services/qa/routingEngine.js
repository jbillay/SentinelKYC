// Phase 5 — pure routing on the final risk tier (post-knockouts).
//
//   passed && tier == 'Low'    → auto_approved
//   passed && tier == 'Medium' → streamlined_review
//   passed && tier == 'High'   → standard_review
//   !passed                    → standard_review
//
// `passed` is the AND of completeness.passed and consistency.passed.
//
// Routing is intentionally tier-based, not score-based: the tier already
// incorporates screening knockouts (a confirmed sanctions hit forces
// tier=High via screeningHighOverride), whereas the raw score does not.

function route({ passed, tier, completenessMissing = [], consistencyIssues = [] }) {
  const normalizedTier = typeof tier === 'string' ? tier : null;

  if (!passed) {
    return {
      caseStatus: 'standard_review',
      qaSummary: `QA failed: ${completenessMissing.length} completeness issue(s), ${consistencyIssues.length} consistency issue(s) → standard review.`,
    };
  }

  if (normalizedTier === 'Low') {
    return {
      caseStatus: 'auto_approved',
      qaSummary: 'QA passed; risk tier Low → auto-approved.',
    };
  }

  if (normalizedTier === 'Medium') {
    return {
      caseStatus: 'streamlined_review',
      qaSummary: 'QA passed; risk tier Medium → streamlined review.',
    };
  }

  if (normalizedTier === 'High') {
    return {
      caseStatus: 'standard_review',
      qaSummary: 'QA passed; risk tier High → standard review.',
    };
  }

  // Unknown / missing tier — fall back to the safest route. assess_risk
  // always sets a tier; this branch exists for defensive completeness.
  return {
    caseStatus: 'standard_review',
    qaSummary: `QA passed; risk tier "${normalizedTier ?? 'unknown'}" → standard review (defensive default).`,
  };
}

module.exports = { route };
