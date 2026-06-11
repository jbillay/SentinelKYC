// Latin-only normalization. Multilingual matching is out of scope for v1
// (see CLAUDE.md / SCREENING_PLAN.md §11).

const CORP_ABBREV = [
  ['LIMITED', 'LTD'],
  ['INCORPORATED', 'INC'],
  ['COMPANY', 'CO'],
  ['CORPORATION', 'CORP'],
  ['AND', '&'],
];

function foldDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function expandCorpAbbrev(tokens) {
  // Canonicalize to the long form so two records that differ only in
  // LTD vs LIMITED still produce the same token set.
  const map = new Map();
  for (const [long, short] of CORP_ABBREV) {
    map.set(short, long);
  }
  return tokens.map((t) => map.get(t) || t);
}

function tokenize(s) {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function tokenSort(tokens) {
  return [...tokens].sort();
}

function normalizeName(input) {
  if (!input) return '';
  let s = String(input);
  s = foldDiacritics(s);
  s = s.toUpperCase();
  s = s.replace(/[^A-Z0-9& ]+/g, ' '); // drop punctuation, keep & for AND mapping
  s = s.replace(/\s+/g, ' ').trim();
  let tokens = tokenize(s);
  tokens = expandCorpAbbrev(tokens);
  return tokens.join(' ');
}

function firstToken(normalized) {
  if (!normalized) return '';
  const ix = normalized.indexOf(' ');
  return ix === -1 ? normalized : normalized.slice(0, ix);
}

module.exports = {
  normalizeName,
  foldDiacritics,
  expandCorpAbbrev,
  tokenize,
  tokenSort,
  firstToken,
};
