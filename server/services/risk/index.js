// Risk engine — barrel + the one-shot `assessRisk` entry point.
//
// `assessRisk` is deterministic given its inputs and does no Postgres / network
// I/O of its own, with one R4 exception: a registered-office country that is
// not in the static lookup table is resolved (and cached) via the reasoning
// model inside `normalizeCountry`, which is why `assessRisk` is async. Given
// the relevant run state plus a matrix version it returns the score, tier,
// outcome, per-factor breakdown, knockouts, trajectory delta, and a full audit
// receipt. The LLM *rationale* field is filled in by the `assess_risk` graph
// node — it is *not* this module's concern.
//
// `matrix` may be either:
//   - { versionId, version, body }  (the shape services/risk/matrix.js#loadActiveMatrix returns), or
//   - the matrix body JSON directly (versionId/version recorded as null).

const { normalizeCountry, normalizeSicCodes } = require('./normalize');
const {
  round2,
  computeGeographic,
  computeEntityType,
  computeStructuralComplexity,
  computeIndustry,
} = require('./factors');
const { applyKnockouts } = require('./knockouts');
const { scoreToTier } = require('./thresholds');
const { buildReceipt } = require('./receipt');

function unwrapMatrix(matrix) {
  if (matrix && typeof matrix === 'object' && matrix.body && typeof matrix.body === 'object') {
    return {
      body: matrix.body,
      versionId: matrix.versionId !== undefined ? matrix.versionId : null,
      version: matrix.version !== undefined ? matrix.version : null,
    };
  }
  return { body: matrix || {}, versionId: null, version: null };
}

function previousScoreOf(previousAssessment) {
  const s = previousAssessment && previousAssessment.score;
  return typeof s === 'number' && Number.isFinite(s) ? s : null;
}

async function assessRisk({ profile, kycCard, psc, screeningReport, previousAssessment, matrix } = {}) {
  const { body, versionId, version } = unwrapMatrix(matrix);
  const calculatedAt = new Date().toISOString();
  const warnings = [];

  // 1. normalize inputs
  // Country source: registered-office country from CH first, kycCard fallback
  // second. CH's registered_office_address.country is frequently blank for UK
  // companies because the registry is UK-only — synthesize_card defaults
  // kycCard.identity.countryOfIncorporation to "United Kingdom" precisely so
  // geographic risk doesn't degrade to "Country not stated" for the most
  // common case.
  const addr = (profile && profile.registered_office_address) || {};
  const cardCountry = kycCard && kycCard.identity && kycCard.identity.countryOfIncorporation;
  const rawCountry = addr.country || cardCountry || null;
  const normalizedCountry = await normalizeCountry(rawCountry);
  if (!normalizedCountry.iso2) {
    warnings.push(`country "${rawCountry ?? ''}" did not normalize to ISO-2 — geographic factor used default`);
  }
  const sicCodes = normalizeSicCodes(profile);
  if (sicCodes.length === 0) {
    warnings.push('profile has no SIC codes — industry factor used default');
  }

  // 2. four factors
  const fGeo = computeGeographic(profile, body, normalizedCountry, { kycCard });
  const fEnt = computeEntityType(profile, body);
  const fStruct = computeStructuralComplexity(profile, psc, kycCard, body);
  const fInd = computeIndustry(profile, body, sicCodes);
  const factors = [fGeo, fEnt, fStruct, fInd];

  // 3. weighted sum
  const score = round2(factors.reduce((acc, f) => acc + f.contribution, 0));

  // 4. base tier from thresholds
  const baseTier = scoreToTier(score, body);

  // 5. knockouts (may bump tier and/or set outcome to Prohibited)
  const ko = applyKnockouts({ tier: baseTier, screeningReport, matrix: body });

  // 6. trajectory delta
  const previousScore = previousScoreOf(previousAssessment);
  const deltaFromPrevious = previousScore != null ? round2(score - previousScore) : null;
  const deltaFlagThreshold =
    body && body.trajectory && typeof body.trajectory.deltaFlagThreshold === 'number'
      ? body.trajectory.deltaFlagThreshold
      : 15;
  const deltaFlagged = deltaFromPrevious != null && Math.abs(deltaFromPrevious) >= deltaFlagThreshold;

  // 7. audit receipt
  const receipt = buildReceipt({
    calculatedAt,
    inputs: {
      country: { raw: rawCountry, iso2: normalizedCountry.iso2, source: normalizedCountry.source },
      entityType: { raw: (profile && profile.type) ?? null, normalized: fEnt.attribute.type, matched: fEnt.attribute.matched },
      sicCodes,
      psc: { total: ((psc && psc.items) || []).length, corporate: fStruct.attribute.corporatePscCount },
      shareholderLayers: fStruct.attribute.shareholderLayers,
      shareholdersFromCard: ((kycCard && kycCard.shareholders) || []).length,
      screeningSummary: (screeningReport && screeningReport.summary) || null,
      baseTier,
    },
    factors,
    score,
    knockouts: ko,
    tier: ko.tier,
    outcome: ko.outcome,
    matrixVersionId: versionId,
    matrixVersion: version,
    previousScore,
    deltaFromPrevious,
    deltaFlagThreshold,
    deltaFlagged,
    warnings,
  });

  return {
    score,
    tier: ko.tier,
    outcome: ko.outcome,
    factors,
    knockoutsTriggered: ko.triggered,
    deltaFromPrevious,
    deltaFlagged,
    matrixVersionId: versionId,
    matrixVersion: version,
    calculatedAt,
    receipt,
    // `rationale` is added by the assess_risk node (templated in R3, LLM in R4)
  };
}

module.exports = {
  assessRisk,
  // re-exports for callers / tests
  normalizeCountry,
  normalizeSicCodes,
  computeGeographic,
  computeEntityType,
  computeStructuralComplexity,
  computeIndustry,
  applyKnockouts,
  scoreToTier,
  buildReceipt,
  round2,
};
