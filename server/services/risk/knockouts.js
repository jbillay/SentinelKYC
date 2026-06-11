// Knockout handlers. Each reads `screeningReport.summary` only — the single
// source of truth for screening outcomes (its `overallRisk` is itself the
// product of the deterministic risk rule in services/screening/report.js:
// `high` ⇔ a confirmed sanctions hit, `medium` ⇔ serious confirmed adverse
// media or a sanctions needs_review).
//
// Tags are enumerated here, not eval'd from the matrix JSON — a POC ships no
// expression engine. Compliance can toggle a tag (matrix.knockouts.<tag> =
// true|false) but cannot invent new ones without a code change.

const TIER_RANK = { Low: 0, Medium: 1, High: 2 };
const RANK_TIER = ['Low', 'Medium', 'High'];

function maxTier(a, b) {
  return (TIER_RANK[a] ?? 0) >= (TIER_RANK[b] ?? 0) ? a : b;
}

// tag → predicate(summary) → does it fire?
const TRIGGERS = {
  screeningProhibited: (s) => !!s && s.overallRisk === 'high',
  screeningHighOverride: (s) => !!s && s.overallRisk === 'high',
  screeningMediumFloor: (s) => !!s && s.overallRisk === 'medium',
};

const KNOWN_TAGS = Object.keys(TRIGGERS);

// Applies the enabled knockouts in increasing severity. Returns
// { tier, outcome, triggered: [tagNames] }. `tier` stays in
// {Low,Medium,High}; `outcome` mirrors `tier` unless `screeningProhibited`
// fires, in which case it's `Prohibited`.
function applyKnockouts({ tier, screeningReport, matrix }) {
  const summary = (screeningReport && screeningReport.summary) || null;
  const flags = (matrix && matrix.knockouts) || {};
  const triggered = [];

  let nextTier = tier;
  let prohibited = false;

  if (flags.screeningMediumFloor && TRIGGERS.screeningMediumFloor(summary)) {
    triggered.push('screeningMediumFloor');
    nextTier = maxTier(nextTier, 'Medium');
  }
  if (flags.screeningHighOverride && TRIGGERS.screeningHighOverride(summary)) {
    triggered.push('screeningHighOverride');
    nextTier = 'High';
  }
  if (flags.screeningProhibited && TRIGGERS.screeningProhibited(summary)) {
    triggered.push('screeningProhibited');
    nextTier = 'High';
    prohibited = true;
  }

  return { tier: nextTier, outcome: prohibited ? 'Prohibited' : nextTier, triggered };
}

module.exports = { applyKnockouts, maxTier, TRIGGERS, KNOWN_TAGS, TIER_RANK, RANK_TIER };
