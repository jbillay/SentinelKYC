// Phase 5 / Q2 — pure projection of graph state into the spec-shaped object
// that the completeness + consistency checks consume.
//
// Pure function. No I/O, no LLM. The shape mirrors the QA-agent spec
// (registry_record / ubo_list / screening_results / risk_score /
// risk_narrative / document_status) but also passes through enough of the
// raw state for the consistency check to look at riskAssessment.knockoutsTriggered,
// kycCard.identity.status and per-document extracted blobs.

const { normalizeName } = require('../sanctions/normalize');

// Party-aware path. When the resolver has run, state.parties + state.partyLinks
// are the canonical source for UBOs (psc + shareholder roles — officers are
// not UBOs). Using party.fullName aligns the UBO names with what
// compileScreeningList screened, so consistencyCheck doesn't false-positive
// ubo_not_screened on a surface-form mismatch between CH's raw PSC name and
// the party's canonical fullName.
function buildUboListFromParties(state) {
  const partiesById = new Map((state.parties || []).map((p) => [p.id, p]));
  const seenPartyIds = new Set();
  const out = [];
  for (const link of state.partyLinks || []) {
    if (link.status !== 'active') continue;
    if (link.role !== 'psc' && link.role !== 'shareholder') continue;
    if (!link.partyId || seenPartyIds.has(link.partyId)) continue;
    const party = partiesById.get(link.partyId);
    if (!party?.fullName) continue;
    seenPartyIds.add(link.partyId);
    out.push({
      name: party.fullName,
      normalizedName: normalizeName(party.fullName),
      source: link.role,
      kind: party.partyType === 'organisation' ? 'corporate' : 'individual',
      partyId: party.id,
    });
  }
  return out;
}

// Legacy path — raw CH PSC + extracted shareholders. Used when the resolver
// hasn't run (synthetic states, screening-only fallback). Dedupe by normalized
// name; first occurrence wins.
function buildUboListLegacy(state) {
  const out = [];
  const seen = new Set();

  const pscs = state.psc?.items || [];
  for (const p of pscs) {
    if (!p?.name) continue;
    if (p.ceased_on || p.ceased) continue;
    const normalized = normalizeName(p.name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const kindStr = String(p.kind || '').toLowerCase();
    const kind = kindStr.includes('corporate') || kindStr.includes('legal-person') ? 'corporate' : 'individual';
    out.push({ name: p.name, normalizedName: normalized, source: 'psc', kind });
  }

  const shareholders = state.kycCard?.shareholders || [];
  for (const sh of shareholders) {
    if (!sh?.name) continue;
    const normalized = normalizeName(sh.name);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const kind = sh.type === 'corporate' ? 'corporate' : 'individual';
    out.push({ name: sh.name, normalizedName: normalized, source: 'shareholder', kind });
  }

  return out;
}

function buildUboList(state) {
  if (Array.isArray(state.partyLinks) && state.partyLinks.length) {
    return buildUboListFromParties(state);
  }
  return buildUboListLegacy(state);
}

function projectCase(state = {}) {
  const documents = Array.isArray(state.documents) ? state.documents : [];
  return {
    registry_record: state.profile ?? null,
    ubo_list: buildUboList(state),
    screening_results: state.screeningReport ?? null,
    risk_score: state.riskAssessment?.score ?? null,
    risk_narrative: state.riskAssessment?.rationale ?? null,
    document_status: documents.map((d) => ({
      category: d.category,
      status: d.status,
      processedBy: d.processedBy ?? null,
      error: d.error ?? null,
    })),
    // Pass-throughs needed by consistencyCheck. Kept on the projection so the
    // checks remain pure functions of a single argument.
    kycCard: state.kycCard ?? null,
    riskAssessment: state.riskAssessment ?? null,
    documents,
  };
}

module.exports = {
  projectCase,
  buildUboList,
};
