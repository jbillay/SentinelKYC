// JS mirror of the SQL `name_canonical()` function (migration 0012).
//
// The party master's `name_canonical` column is computed in Postgres. The
// in-graph shareholder-graph rewrite (resolveParties.js) needs to map a node's
// surface form back to the party it resolved to, and to do that it has to
// canonicalise the label the SAME way the SQL function does. Using a DIFFERENT
// normaliser (e.g. services/sanctions/normalize.js, which does NOT strip
// honorifics) means a title-bearing surface form like "Mr Vincent Huard"
// canonicalises to "...mr..." and never matches the party's "vincent huard"
// canonical — so the node fails to collapse onto its party and renders as a
// duplicate. This is exactly the bug this module exists to prevent.
//
// MUST stay in lock-step with migration 0012's name_canonical(). If one
// changes, change both. The four steps mirror the SQL:
//   1. lower + fold diacritics (unaccent)
//   2. strip honorifics (mr, mrs, ms, dr, prof, sir, ...)
//   3. apostrophes removed; other punctuation → space; collapse whitespace
//   4. tokenise, sort alphabetically, rejoin

// Ordered longest-first so the leftmost-match alternation doesn't let a bare
// 'm' grab the head of 'mme' / 'mlle'. Mirrors the SQL alternation order.
const HONORIFICS = ['prof', 'mlle', 'mme', 'mrs', 'sir', 'dr', 'jr', 'mr', 'ms', 'sr', 'm'];
// (^|[^a-z0-9]) preserves the leading separator; the lookahead requires a
// trailing non-alphanumeric or end-of-string, so only stand-alone honorific
// tokens (with optional trailing dot) are stripped — 'mary' / 'morten' survive.
const HONORIFIC_RE = new RegExp(
  `(^|[^a-z0-9])(${HONORIFICS.join('|')})\\.?(?=[^a-z0-9]|$)`,
  'g'
);

// Letters NFD cannot fold (stroked/ligature forms carry no combining mark).
// Postgres unaccent maps them to plain ASCII; without this supplement the JS
// twin drops them at the punctuation strip instead (Łukasz → "ukasz" vs SQL
// "lukasz") — a drift the canonical parity smoke caught. Mappings verified
// against the live unaccent dictionary; keep in lock-step with it.
const UNACCENT_SUPPLEMENT = {
  'Ł': 'L', 'ł': 'l', 'Ø': 'O', 'ø': 'o', 'Đ': 'D', 'đ': 'd',
  'Æ': 'AE', 'æ': 'ae', 'Œ': 'OE', 'œ': 'oe', 'ß': 'ss',
  'Þ': 'TH', 'þ': 'th', 'Ð': 'D', 'ð': 'd', 'Ħ': 'H', 'ħ': 'h',
  'Ŧ': 'T', 'ŧ': 't', 'ı': 'i', 'Ŋ': 'N', 'ŋ': 'n', 'Ŀ': 'L', 'ŀ': 'l',
};
const UNACCENT_SUPPLEMENT_RE = new RegExp(`[${Object.keys(UNACCENT_SUPPLEMENT).join('')}]`, 'g');

function foldDiacritics(s) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(UNACCENT_SUPPLEMENT_RE, (ch) => UNACCENT_SUPPLEMENT[ch]);
}

// Canonical form used for party-identity equality. Returns a space-joined,
// alphabetically-sorted token string. Empty string for null/blank input.
function nameCanonical(input) {
  if (!input) return '';
  let s = foldDiacritics(String(input)).toLowerCase(); // step 1
  s = s.replace(HONORIFIC_RE, '$1 '); // step 2
  s = s.replace(/'/g, ''); // step 3a — apostrophes removed (O'Hara → OHara)
  s = s.replace(/[^a-z0-9 ]+/g, ' '); // step 3b — other punctuation → space
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.split(' ').filter(Boolean).sort().join(' '); // step 4
}

// Token list (deduped) for subset / overlap comparisons. Deduping matters for
// the subset test: "John John Smith" shouldn't out-rank "John Smith".
function canonicalTokens(input) {
  const c = nameCanonical(input);
  if (!c) return [];
  return [...new Set(c.split(' '))];
}

// True when `aTokens` is a non-trivial strict subset of `bTokens` — i.e. every
// token of A appears in B, A is smaller than B, and A has at least `minTokens`
// tokens (default 2, so a lone forename/surname never absorbs a full name).
// Used by the graph rewrite to fold a partial-name node ("Vincent Huard",
// from an OCR'd confirmation statement) onto the full-name person node
// ("Vincent Matthieu Benjamin Huard", from Companies House).
function isStrictSubset(aTokens, bTokens, minTokens = 2) {
  if (aTokens.length < minTokens) return false;
  if (aTokens.length >= bTokens.length) return false;
  const bSet = new Set(bTokens);
  return aTokens.every((t) => bSet.has(t));
}

module.exports = { nameCanonical, canonicalTokens, isStrictSubset, foldDiacritics };
