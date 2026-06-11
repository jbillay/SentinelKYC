// Phase 5 — consistency check.
//
// Pure. Cross-agent sanity checks over the projected case. Tier-based: any
// confirmed sanctions hit must produce tier=High (via the screening
// knockout engine), and any screening knockout must produce tier=High.
// Issue codes are stable; UI strings live in issueMap.js.

const { normalizeName } = require('../sanctions/normalize');

const SCREENING_KNOCKOUTS = new Set(['screeningHighOverride', 'screeningProhibited']);

function isDissolutionRelated(extracted) {
  if (!extracted || typeof extracted !== 'object') return null;
  // Best-effort scan. Absent ⇒ check is skipped (no false positives).
  if (extracted.dissolutionDate) {
    return { field: 'dissolutionDate', value: extracted.dissolutionDate };
  }
  if (typeof extracted.status === 'string' && extracted.status.toLowerCase() === 'dissolved') {
    return { field: 'status', value: extracted.status };
  }
  return null;
}

function checkConsistency(projection = {}) {
  const issues = [];

  // 1. ubo_not_screened — any UBO not present in screening_results.perSubject.
  // Match by partyId first (the canonical post-resolver key — robust against
  // surface-form drift between a CH PSC name and the party's fullName), then
  // fall back to normalized-name for legacy paths where the resolver hasn't
  // run and neither side carries a partyId.
  const perSubject = projection.screening_results?.perSubject || [];
  const screenedNames = new Set(
    perSubject
      .map((s) => normalizeName(s?.name || ''))
      .filter(Boolean),
  );
  const screenedPartyIds = new Set(
    perSubject
      .map((s) => s?.partyId)
      .filter(Boolean),
  );
  const missingSubjects = [];
  for (const ubo of projection.ubo_list || []) {
    const hasPartyMatch = ubo?.partyId && screenedPartyIds.has(ubo.partyId);
    const hasNameMatch = ubo?.normalizedName && screenedNames.has(ubo.normalizedName);
    if (hasPartyMatch || hasNameMatch) continue;
    if (!ubo?.normalizedName && !ubo?.partyId) continue;
    missingSubjects.push(ubo.name);
  }
  if (missingSubjects.length > 0) {
    issues.push({
      code: 'ubo_not_screened',
      message: `${missingSubjects.length} UBO(s) not present in screening results`,
      evidence: { missingSubjects },
    });
  }

  const confirmedHits = projection.screening_results?.summary?.confirmedHits ?? 0;
  const tier = projection.riskAssessment?.tier ?? null;

  // 2. tier_too_low_for_sanction_hit — confirmed sanctions hits must force
  //    tier=High via the screeningHighOverride knockout. If they don't, the
  //    knockout configuration is broken or the screening report is stale.
  if (confirmedHits > 0 && tier !== 'High') {
    issues.push({
      code: 'tier_too_low_for_sanction_hit',
      message: `Confirmed sanctions hit(s) present but risk tier is ${tier ?? 'unknown'} (expected High)`,
      evidence: {
        confirmedHits,
        tier,
      },
    });
  }

  // 3. tier_too_low_for_knockout — defensive: a screening knockout was
  //    triggered but the resulting tier is not High. The knockout engine
  //    should make this impossible; if it fires, something upstream is off.
  const knockouts = projection.riskAssessment?.knockoutsTriggered || [];
  const triggered = knockouts.filter((k) => SCREENING_KNOCKOUTS.has(k));
  if (triggered.length > 0 && tier !== 'High') {
    issues.push({
      code: 'tier_too_low_for_knockout',
      message: `Screening knockout(s) ${triggered.join(', ')} triggered but risk tier is ${tier ?? 'unknown'} (expected High)`,
      evidence: {
        knockouts: triggered,
        tier,
      },
    });
  }

  // 4. status_contradiction_registry — profile vs kycCard identity status.
  const registryStatus = projection.registry_record?.company_status;
  const cardStatus = projection.kycCard?.identity?.status;
  if (registryStatus && cardStatus) {
    const registryActive = String(registryStatus).toLowerCase() === 'active';
    const cardActive = String(cardStatus).toLowerCase() === 'active';
    if (registryActive !== cardActive) {
      issues.push({
        code: 'status_contradiction_registry',
        message: `Registry status "${registryStatus}" disagrees with KYC card status "${cardStatus}"`,
        evidence: { registry: registryStatus, card: cardStatus },
      });
    }
  }

  // 5. status_contradiction_document — extracted dissolution signal vs an
  // active registry status. Skipped silently when no document carries either
  // field (absent ⇒ no false positive).
  if (
    registryStatus
    && String(registryStatus).toLowerCase() === 'active'
    && Array.isArray(projection.documents)
  ) {
    for (const d of projection.documents) {
      const hit = isDissolutionRelated(d?.extracted);
      if (hit) {
        issues.push({
          code: 'status_contradiction_document',
          message: `Document "${d.category}" carries a dissolution signal (${hit.field}=${hit.value}) but registry says active`,
          evidence: {
            category: d.category,
            transactionId: d.transactionId,
            field: hit.field,
            value: hit.value,
            registry: registryStatus,
          },
        });
      }
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

module.exports = {
  checkConsistency,
  SCREENING_KNOCKOUTS,
};
