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

// Agents whose absence makes auto-approval indefensible: with screening or
// risk disabled the case was never fully assessed, so it must reach a human
// regardless of how clean the remaining signals look (fail toward review).
const REVIEW_FORCING_AGENTS = ['screening', 'risk-assessment'];

function route({ passed, tier, completenessMissing = [], consistencyIssues = [], skippedAgents = [] }) {
  const normalizedTier = typeof tier === 'string' ? tier : null;

  const forcing = REVIEW_FORCING_AGENTS.filter((a) => skippedAgents.includes(a));
  if (forcing.length > 0) {
    return {
      caseStatus: 'standard_review',
      qaSummary: `Assessment incomplete: ${forcing.join(' + ')} agent(s) disabled for this run → standard review (auto-approval requires a full assessment).`,
    };
  }

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

module.exports = { route, REVIEW_FORCING_AGENTS };
