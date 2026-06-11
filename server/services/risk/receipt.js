// Builds the audit "receipt" for a risk assessment: raw inputs (with evidence
// paths), per-factor weight/baseScore/contribution, knockouts that fired, the
// tier/outcome, the trajectory delta, and which matrix version was used. The
// receipt is what a reviewer reads to reconstruct exactly how the score came
// to be — keep it explicit and side-effect free.

function buildReceipt({
  calculatedAt,
  inputs,
  factors,
  score,
  knockouts,
  tier,
  outcome,
  matrixVersionId,
  matrixVersion,
  previousScore,
  deltaFromPrevious,
  deltaFlagThreshold,
  deltaFlagged,
  warnings,
}) {
  return {
    schemaVersion: 1,
    calculatedAt: calculatedAt || new Date().toISOString(),
    matrix: { versionId: matrixVersionId ?? null, version: matrixVersion ?? null },
    inputs: inputs || {},
    factors: (factors || []).map((f) => ({
      factor: f.factor,
      label: f.label ?? null,
      weight: f.weight,
      baseScore: f.baseScore,
      contribution: f.contribution,
      attribute: f.attribute ?? null,
      evidence: f.evidence ?? null,
    })),
    score,
    scoreBeforeKnockouts: score,
    tier,
    outcome,
    knockoutsTriggered: (knockouts && knockouts.triggered) || [],
    trajectory: {
      previousScore: typeof previousScore === 'number' && Number.isFinite(previousScore) ? previousScore : null,
      delta: typeof deltaFromPrevious === 'number' && Number.isFinite(deltaFromPrevious) ? deltaFromPrevious : null,
      flagThreshold: typeof deltaFlagThreshold === 'number' ? deltaFlagThreshold : null,
      flagged: !!deltaFlagged,
    },
    warnings: Array.isArray(warnings) ? warnings : [],
  };
}

module.exports = { buildReceipt };
