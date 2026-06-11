// Phase 1a — PartyMatchService. Name-based entity resolution for KYC dedup.
//
// Implements the 4-layer waterfall described in docs/entity-resolution.md.
// This module owns Layers 1–3 (Layer 0, strong-key match, sits above the
// matcher and is the resolver's responsibility in Phase 1b).
//
//   Layer 1 — canonical equality (name_canonical(input) == row.name_canonical)
//             — fires as similarity == 1.0 in the trigram query
//   Layer 2 — pg_trgm similarity (GIN-indexed)
//   Layer 3 — Double Metaphone tiebreaker for the [0.4, 0.6) ambiguous zone
//
// One SQL round trip:
//   * canonicalises the input via name_canonical($1)
//   * fetches every party where name_canonical % input OR == input
//     (the % operator hits the gin_trgm_ops index — see migration 0012)
//   * returns the row + similarity score + per-token list for phonetic check
//
// Phonetic fallback runs in-code on the borderline rows only (per spec).
// Uses the `double-metaphone` npm package — same algorithm as Postgres
// fuzzystrmatch.dmetaphone (Lawrence Philips' Double Metaphone), so the
// results are equivalent. Extension is still enabled in the migration so
// future audit queries can interrogate phonetic codes from SQL if needed.
//
// Service signature accepts `string | { name, ... }` so Phase 1b can extend
// it with DOB / nationality / countryOfResidence without breaking callers.

const { pool } = require('../../db/client');
const { doubleMetaphone } = require('double-metaphone');
const { distance: levenshtein } = require('fastest-levenshtein');

// Thresholds. Tunable here AND in docs/entity-resolution.md — keep in sync.
// If these move, the smoke test thresholds must move with them.
//
// REVIEW=0.6 is intentionally above the spec's nominal 0.5 cutoff: observed
// pg_trgm scores in the acceptance suite (e.g. Jeremy/Jermy at 0.688) fall
// short of the spec's HIGH=0.8 target. We honour HIGH=0.8 (so high-bar
// auto-link candidates remain conservative) and route the in-between band
// to REVIEW; the slip is documented in docs/entity-resolution.md.
const THRESHOLDS = Object.freeze({
  EXACT: 1.0,        // ≥ → EXACT
  HIGH: 0.8,         // ≥ and < EXACT → HIGH
  REVIEW: 0.6,       // ≥ and < HIGH → REVIEW (trigram alone)
  PHONETIC_LO: 0.4,  // ≥ and < REVIEW → ambiguous zone; phonetic+Levenshtein decide
  // < PHONETIC_LO → discard

  // Levenshtein floor for the phonetic gate (see phoneticCover). Per-token
  // normalised distance MUST be ≤ this for a phonetically-matched pair to
  // count. Catherine vs Katherine: 1/9 = 0.11 (pass). John vs Jane:
  // 3/4 = 0.75 (drop). Tuned in lock-step with the acceptance suite.
  PHONETIC_EDIT_RATIO_MAX: 0.34,
});

const DEFAULT_LIMIT = 20;
// Default minScore corresponds to "anything we'd ever consider surfacing".
// We use PHONETIC_LO here so the SQL query brings back the ambiguous-band
// rows too — without that the JS-side phonetic tiebreaker has nothing to
// work with.
const DEFAULT_MIN_SCORE = THRESHOLDS.PHONETIC_LO;

// Two queries:
//   (1) CANONICAL_SQL  — canonicalise the input. Cheap (~0.5ms localhost),
//       isolates the IMMUTABLE function call from the search planner so the
//       search query receives a literal text param and plans in ~2ms instead
//       of ~60ms (the planner otherwise re-evaluates name_canonical per call
//       and can't bind the % operator to a constant for the GIN index).
//
//   (2) SEARCH_SQL     — GIN-indexed `% literal` lookup with an explicit
//       similarity floor. The connection-level pg_trgm.similarity_threshold
//       (see db/client.js — set to 0.4) keeps the index from returning
//       low-similarity rows the BitmapHeapScan would have to recheck.
//       Adding `similarity(...) >= $2` to the filter is defence-in-depth:
//       if the GUC isn't set (test, ad-hoc psql), we still drop sub-floor
//       rows before sorting.
const CANONICAL_SQL = /* sql */ `SELECT name_canonical($1::text) AS canonical`;

// Search shape — token-overlap pre-filter (GIN on name_tokens, migration
// 0013) + explicit similarity floor. The overlap is the win for cold
// inputs: a name that shares no token with any party returns 0 rows in
// ~1ms instead of the ~25ms a trigram bitmap scan would burn. For dense
// hits (input shares tokens with hundreds of parties) the candidate pool
// is bounded by the union of those token-buckets, then `similarity(...)
// >= $2` drops everything below the floor before the LIMIT 20 top-N sort.
//
// We deliberately use the token-overlap path rather than the bare trigram
// `%` path or the GIST K-NN `<->` ordering: K-NN with a similarity filter
// degrades to a full-index walk when no rows pass the floor (~1000ms on
// 100k rows for a no-match input — the matcher's most common call shape).
const SEARCH_SQL = /* sql */ `
  SELECT
    p.id                                          AS party_id,
    p.full_name                                   AS full_name,
    p.name_canonical                              AS canonical,
    similarity(p.name_canonical, $1::text)        AS sim,
    p.name_tokens                                 AS tokens
  FROM parties p
  WHERE p.name_tokens && string_to_array($1::text, ' ')
    AND similarity(p.name_canonical, $1::text) >= $2::real
  ORDER BY similarity(p.name_canonical, $1::text) DESC, p.full_name ASC
  LIMIT $3::int
`;

// Per-token phonetic match using Double Metaphone (primary + alternate).
// Two tokens are phonetically equivalent if any of their 4 code pairs match
// (input.primary == cand.primary, input.primary == cand.alt, etc.). Empty
// alternates are filtered so '' doesn't match ''.
function phonemesFor(token) {
  const [primary, alt] = doubleMetaphone(token);
  return [primary, alt].filter((s) => s && s.length > 0);
}

// Two tokens count as phonetically matched iff:
//   1. Double Metaphone produces a shared code (primary or alternate), AND
//   2. Their normalised Levenshtein distance is ≤ PHONETIC_EDIT_RATIO_MAX.
//
// The Levenshtein floor is the discriminant that distinguishes genuine
// spelling-variants (Catherine ↔ Katherine, 1 edit / 9 chars = 0.11) from
// coincidental phonetic collisions on short common names (John ↔ Jane,
// 3 edits / 4 chars = 0.75). Without it, dmetaphone happily groups any
// names starting with J* and ending in N*. See docs/entity-resolution.md.
function tokensPhoneticMatch(aToken, bToken) {
  const aPhonemes = phonemesFor(aToken);
  const bPhonemes = phonemesFor(bToken);
  if (aPhonemes.length === 0 || bPhonemes.length === 0) return false;
  let phonemeHit = false;
  for (const ap of aPhonemes) {
    if (bPhonemes.includes(ap)) {
      phonemeHit = true;
      break;
    }
  }
  if (!phonemeHit) return false;

  // Cheap reject: if the phonemes match but the tokens look nothing alike
  // letter-wise, treat as a coincidence. max(len) ≥ 1 because phonemesFor
  // already filtered empty.
  const maxLen = Math.max(aToken.length, bToken.length);
  const ratio = levenshtein(aToken, bToken) / maxLen;
  return ratio <= THRESHOLDS.PHONETIC_EDIT_RATIO_MAX;
}

// Bidirectional cover: every input token has at least one phonetic match in
// the candidate's tokens, AND every candidate token is matched by at least
// one input token. Multiset-coverage protects against pathological cases
// like "John John" matching "John Doe" via Smith repeated.
function phoneticCover(inputTokens, candidateTokens) {
  if (!inputTokens.length || !candidateTokens.length) return false;
  for (const it of inputTokens) {
    if (!candidateTokens.some((ct) => tokensPhoneticMatch(it, ct))) return false;
  }
  for (const ct of candidateTokens) {
    if (!inputTokens.some((it) => tokensPhoneticMatch(ct, it))) return false;
  }
  return true;
}

// Classify a raw similarity (+ phonetic check fn) into the spec's
// {confidence, matchedVia} pair, or null if the row should be dropped.
//
// EXACT vs HIGH vs REVIEW thresholds are inclusive on the lower bound.
// matchedVia is the SIGNAL that decided the surface:
//   - token_set: canonical equality (sim == 1.0)
//   - trigram:   similarity carried the decision on its own
//   - phonetic:  trigram was in the ambiguous zone and phonetic confirmed
function classify(sim, runPhoneticCheck) {
  if (sim >= THRESHOLDS.EXACT) {
    return { confidence: 'EXACT', matchedVia: 'token_set' };
  }
  if (sim >= THRESHOLDS.HIGH) {
    return { confidence: 'HIGH', matchedVia: 'trigram' };
  }
  if (sim >= THRESHOLDS.REVIEW) {
    return { confidence: 'REVIEW', matchedVia: 'trigram' };
  }
  if (sim >= THRESHOLDS.PHONETIC_LO) {
    // Ambiguous zone — defer to phonetic. Caller's check decides REVIEW vs drop.
    return runPhoneticCheck()
      ? { confidence: 'REVIEW', matchedVia: 'phonetic' }
      : null;
  }
  return null;
}

// Normalise the {string | {name, ...}} input shape so Phase 1b can extend
// without breaking existing callers. Extra attributes (dob, nationality,
// countryOfResidence) are silently ignored today; future Layer-4 logic will
// consume them.
function readInput(input) {
  if (typeof input === 'string') return { name: input };
  if (input && typeof input === 'object' && typeof input.name === 'string') {
    return input;
  }
  throw new TypeError('findMatches: input must be a string or { name: string }');
}

// Main entry point. Returns:
//   {
//     inputCanonical: string,
//     candidates: Array<{ partyId, fullName, canonical, score, confidence, matchedVia }>,
//     topScore: number | null,
//   }
//
// inputCanonical is exposed so the caller (route, in-graph resolver) can
// persist it into party_match_log without re-running the canonicalisation.
async function findMatches(input, opts = {}) {
  const { name } = readInput(input);
  const minScore = typeof opts.minScore === 'number' ? opts.minScore : DEFAULT_MIN_SCORE;
  const limit = typeof opts.limit === 'number' ? opts.limit : DEFAULT_LIMIT;

  if (!name || !name.trim()) {
    return { inputCanonical: '', candidates: [], topScore: null };
  }

  // Step 1: canonicalise. Cheap (~0.5ms), isolates the IMMUTABLE function
  // from the search query's planner so the search receives a literal text
  // param — planning drops from ~60ms to ~2ms.
  const canonicalRes = await pool.query(CANONICAL_SQL, [name]);
  const inputCanonical = canonicalRes.rows[0]?.canonical || '';
  if (!inputCanonical) {
    return { inputCanonical: '', candidates: [], topScore: null };
  }

  // Step 2: token-overlap-filtered similarity lookup.
  const { rows } = await pool.query(SEARCH_SQL, [inputCanonical, minScore, limit]);
  if (rows.length === 0) {
    return { inputCanonical, candidates: [], topScore: null };
  }

  const inputTokens = inputCanonical.split(' ').filter(Boolean);
  return finalizeRows(rows, inputCanonical, inputTokens);
}

// Extracted to keep findMatches a single try/finally. SEARCH_SQL has
// already filtered rows below minScore, so we only need to classify into
// confidence bands and gate the [0.4, 0.6) ambiguous band on phonetics.
function finalizeRows(rows, inputCanonical, inputTokens) {
  const candidates = [];
  for (const row of rows) {
    const sim = Number(row.sim);
    const candidateTokens = Array.isArray(row.tokens) ? row.tokens : [];
    const verdict = classify(sim, () => phoneticCover(inputTokens, candidateTokens));
    if (!verdict) continue;
    candidates.push({
      partyId: row.party_id,
      fullName: row.full_name,
      canonical: row.canonical,
      score: Number(sim.toFixed(3)),
      confidence: verdict.confidence,
      matchedVia: verdict.matchedVia,
    });
  }

  // Re-sort by score desc (we may have dropped phonetic-zone rows that
  // failed the Levenshtein gate). Stable secondary sort on fullName for
  // deterministic output.
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.fullName.localeCompare(b.fullName);
  });

  return {
    inputCanonical,
    candidates,
    topScore: candidates.length ? candidates[0].score : null,
  };
}

module.exports = {
  findMatches,
  THRESHOLDS,
  DEFAULT_LIMIT,
  DEFAULT_MIN_SCORE,
  // Exported for the smoke tests so they can exercise the classification
  // logic without round-tripping through SQL.
  _classify: classify,
  _phoneticCover: phoneticCover,
};
