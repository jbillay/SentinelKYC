// The four v1 risk factors. Pure functions: each takes the relevant slice of
// run state plus the matrix body and returns a uniform shape:
//
//   { factor, label, weight, baseScore, contribution, attribute, evidence }
//
// `contribution = round2(weight * baseScore)`; the engine sums contributions
// to get the score. `attribute` is the human-readable "what was matched";
// `evidence` is the audit trail (input paths + raw values).

const { normalizeEntityType } = require('./normalize');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function normName(name) {
  return String(name || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ');
}

function isCorporatePsc(p) {
  const k = String((p && p.kind) || '').toLowerCase();
  return k.includes('corporate') || k.includes('legal-person') || k.includes('legal-entity');
}

function isCeasedPsc(p) {
  return !!(p && (p.ceased_on || p.ceased));
}

// First tier whose `upTo` covers `value` (tiers ascending, open-ended last).
function tierScore(tiers, value) {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  for (const t of tiers) {
    if (t.upTo === null || t.upTo === undefined) return t.score;
    if (value <= t.upTo) return t.score;
  }
  return tiers[tiers.length - 1].score;
}

function longestPrefixMatch(prefixes, code) {
  let best = null;
  for (const p of prefixes || []) {
    if (typeof p.prefix !== 'string' || p.prefix.length === 0) continue;
    if (code.startsWith(p.prefix) && (!best || p.prefix.length > best.prefix.length)) best = p;
  }
  return best;
}

// --- geographic --------------------------------------------------------------
// `normalized` is the result of normalizeCountry() on the resolved country;
// geographic falls back to factors.geographic.default on a miss. The caller
// (assessRisk in services/risk/index.js) resolves the country from CH first,
// kycCard.identity.countryOfIncorporation second — pass the kycCard via opts
// so the audit trail records which source was used.
function computeGeographic(profile, matrix, normalized, opts = {}) {
  const cfg = (matrix.factors && matrix.factors.geographic) || {};
  const weight = (matrix.weights && matrix.weights.geographic) || 0;
  const addr = (profile && profile.registered_office_address) || {};
  const profileCountry = addr.country || null;
  const cardCountry =
    (opts.kycCard && opts.kycCard.identity && opts.kycCard.identity.countryOfIncorporation) || null;
  const rawCountry = profileCountry || cardCountry || null;
  const evidencePath = profileCountry
    ? 'profile.registered_office_address.country'
    : cardCountry
      ? 'kycCard.identity.countryOfIncorporation'
      : 'profile.registered_office_address.country';
  const iso2 = normalized && normalized.iso2 ? normalized.iso2 : null;
  const source = (normalized && normalized.source) || 'unknown';

  let baseScore;
  let matched = false;
  if (iso2 && cfg.scores && Object.prototype.hasOwnProperty.call(cfg.scores, iso2)) {
    baseScore = cfg.scores[iso2];
    matched = true;
  } else {
    baseScore = cfg.default;
  }
  const contribution = round2(weight * baseScore);
  return {
    factor: 'geographic',
    label: cfg.label || 'Geographic risk',
    weight,
    baseScore,
    contribution,
    attribute: { iso2, label: rawCountry, source, matched },
    evidence: { path: evidencePath, rawValue: rawCountry },
  };
}

// --- entity type -------------------------------------------------------------
function computeEntityType(profile, matrix) {
  const cfg = (matrix.factors && matrix.factors.entityType) || {};
  const weight = (matrix.weights && matrix.weights.entityType) || 0;
  const rawType = (profile && profile.type) || null;
  const norm = normalizeEntityType(rawType);

  let baseScore;
  let matched = false;
  if (norm && cfg.scores && Object.prototype.hasOwnProperty.call(cfg.scores, norm)) {
    baseScore = cfg.scores[norm];
    matched = true;
  } else {
    baseScore = cfg.default;
  }
  const contribution = round2(weight * baseScore);
  return {
    factor: 'entityType',
    label: cfg.label || 'Entity type',
    weight,
    baseScore,
    contribution,
    attribute: { type: norm, rawType, matched },
    evidence: { path: 'profile.type', rawValue: rawType },
  };
}

// --- structural complexity ---------------------------------------------------
// Two sub-signals combined as `max`:
//   corporatePscCount  — number of active corporate PSC entries.
//   shareholderLayers  — heuristic ownership depth = 1 (the company) +
//                        corporate PSCs + corporate shareholders (from the
//                        confirmation-statement extraction) not already a PSC.
function computeStructuralComplexity(profile, psc, kycCard, matrix) {
  const cfg = (matrix.factors && matrix.factors.structuralComplexity) || {};
  const weight = (matrix.weights && matrix.weights.structuralComplexity) || 0;

  const pscItems = (psc && psc.items) || [];
  const corporatePscs = pscItems.filter((p) => p && p.name && !isCeasedPsc(p) && isCorporatePsc(p));
  const corporatePscNames = new Set(corporatePscs.map((p) => normName(p.name)));
  const corporatePscCount = corporatePscs.length;

  const shareholders = (kycCard && kycCard.shareholders) || [];
  const nestedCorporateShareholders = shareholders.filter(
    (s) => s && s.name && s.type === 'corporate' && !corporatePscNames.has(normName(s.name)),
  );
  const shareholderLayers = 1 + corporatePscCount + nestedCorporateShareholders.length;

  const scorePsc = tierScore((cfg.corporatePscCount && cfg.corporatePscCount.tiers) || [], corporatePscCount);
  const scoreLayers = tierScore((cfg.shareholderLayers && cfg.shareholderLayers.tiers) || [], shareholderLayers);
  const combineRule = cfg.combineRule || 'max';
  const baseScore = Math.max(scorePsc, scoreLayers);
  const contribution = round2(weight * baseScore);

  return {
    factor: 'structuralComplexity',
    label: cfg.label || 'Structural complexity',
    weight,
    baseScore,
    contribution,
    attribute: {
      corporatePscCount,
      shareholderLayers,
      corporatePscScore: scorePsc,
      shareholderLayersScore: scoreLayers,
      combineRule,
    },
    evidence: {
      paths: ['psc.items[].kind', 'kycCard.shareholders[].type'],
      corporatePscNames: Array.from(corporatePscNames),
      nestedCorporateShareholders: nestedCorporateShareholders.map((s) => s.name),
    },
  };
}

// --- industry ----------------------------------------------------------------
// Longest-prefix match across every SIC code; the highest-scoring match wins.
function computeIndustry(profile, matrix, sicCodes) {
  const cfg = (matrix.factors && matrix.factors.industry) || {};
  const weight = (matrix.weights && matrix.weights.industry) || 0;
  const codes = Array.isArray(sicCodes) ? sicCodes : [];

  let best = null; // { code, prefix, score, label }
  for (const code of codes) {
    const m = longestPrefixMatch(cfg.prefixes, code);
    if (m && (!best || m.score > best.score)) {
      best = { code, prefix: m.prefix, score: m.score, label: m.label };
    }
  }

  let baseScore;
  let attribute;
  if (best) {
    baseScore = best.score;
    attribute = { sicCode: best.code, prefix: best.prefix, label: best.label || null, matched: true };
  } else {
    baseScore = cfg.default;
    attribute = { sicCode: null, prefix: null, label: null, matched: false };
  }
  const contribution = round2(weight * baseScore);
  return {
    factor: 'industry',
    label: cfg.label || 'Industry risk',
    weight,
    baseScore,
    contribution,
    attribute,
    evidence: { path: 'profile.sic_codes', rawValue: codes },
  };
}

module.exports = {
  round2,
  normName,
  isCorporatePsc,
  isCeasedPsc,
  tierScore,
  longestPrefixMatch,
  computeGeographic,
  computeEntityType,
  computeStructuralComplexity,
  computeIndustry,
};
