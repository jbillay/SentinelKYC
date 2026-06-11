// Phase 3 — pure enrichment merge. The base provider's record (Companies
// House shape — the canonical wire format vendors adapt TO) always wins;
// an enrichment vendor only fills fields the merged record does not yet
// have, and every field it contributes is attributed to it.
//
// v1 merges at the top level only: an enricher can fill a missing
// `sic_codes` or add a whole new block, but cannot reach inside an existing
// nested object (deep gap-fill is a v2 concern — it needs per-vendor field
// allow-lists before it is safe).

function isMissing(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

// Returns { merged, attribution } — attribution maps top-level field name →
// vendorId for every field this enrichment actually contributed. `merged` is
// a fresh object; inputs are not mutated.
function mergeEnrichment(base, enrichment, vendorId, priorAttribution = {}) {
  const merged = { ...(base || {}) };
  const attribution = { ...priorAttribution };
  for (const [key, value] of Object.entries(enrichment || {})) {
    if (isMissing(value)) continue;
    if (!isMissing(merged[key])) continue; // base (or an earlier enricher) wins
    merged[key] = value;
    attribution[key] = vendorId;
  }
  return { merged, attribution };
}

// Run a base record through an ordered list of enrichment results
// [{ vendorId, data }]. Attribution is attached as `_vendorAttribution` only
// when at least one field was actually contributed — a CH-only record comes
// out byte-identical to what the base provider returned.
function composeRecord(base, enrichments = []) {
  if (base == null) return base;
  let merged = base;
  let attribution = {};
  for (const { vendorId, data } of enrichments) {
    if (!data) continue;
    ({ merged, attribution } = mergeEnrichment(merged, data, vendorId, attribution));
  }
  if (Object.keys(attribution).length === 0) return base;
  return { ...merged, _vendorAttribution: attribution };
}

module.exports = { mergeEnrichment, composeRecord, isMissing };
