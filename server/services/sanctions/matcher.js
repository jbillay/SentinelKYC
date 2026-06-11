const { distance } = require('fastest-levenshtein');
const { normalizeName, tokenize, firstToken } = require('./normalize');

// double-metaphone is ESM-only. Lazy-loaded on first use.
let _doubleMetaphone = null;
async function getDoubleMetaphone() {
  if (!_doubleMetaphone) {
    const mod = await import('double-metaphone');
    _doubleMetaphone = mod.doubleMetaphone;
  }
  return _doubleMetaphone;
}

// token-set ratio inspired by RapidFuzz: build the intersection and the two
// extension sets, then take the best Levenshtein-based ratio across the
// three pairings. Robust to token reordering and partial overlap.
function tokenSetRatio(a, b) {
  if (!a || !b) return 0;
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  const inter = [...ta].filter((t) => tb.has(t)).sort();
  const diffA = [...ta].filter((t) => !tb.has(t)).sort();
  const diffB = [...tb].filter((t) => !ta.has(t)).sort();
  const s1 = inter.join(' ');
  const s2 = (inter.concat(diffA)).join(' ').trim();
  const s3 = (inter.concat(diffB)).join(' ').trim();
  return Math.max(ratio(s1, s2), ratio(s1, s3), ratio(s2, s3));
}

function ratio(x, y) {
  if (!x && !y) return 1;
  const d = distance(x, y);
  const len = Math.max(x.length, y.length);
  return len === 0 ? 1 : 1 - d / len;
}

async function phoneticBoost(a, b) {
  if (!a || !b) return 0;
  const dm = await getDoubleMetaphone();
  const codesA = Array.isArray(a) ? a : dm(a);
  const codesB = Array.isArray(b) ? b : dm(b);
  // codesA = [primary, secondary]; match if any pair coincides.
  for (const ca of codesA) {
    if (!ca) continue;
    for (const cb of codesB) {
      if (!cb) continue;
      if (ca === cb) return 0.05; // small bump, not enough to clear threshold alone
    }
  }
  return 0;
}

// Score a candidate sanctions entry against a normalized subject name.
// Returns { score, matchedAlias } where matchedAlias is the alias variant
// (or primary name) that produced the best score. `subjectCodes` is the
// pre-computed double-metaphone of the subject — pass it in to avoid
// recomputing per candidate (matchSubject hoists it). See CODE_REVIEW §4.4.
async function scoreEntry(normalizedSubject, entry, subjectCodes = null) {
  const variants = [entry.normalized_name];
  if (Array.isArray(entry.aliases)) {
    for (const a of entry.aliases) {
      if (a && a.normalized) variants.push(a.normalized);
    }
  }
  const codesA = subjectCodes;
  let best = 0;
  let bestVariant = entry.normalized_name;
  for (const v of variants) {
    if (!v) continue;
    const base = tokenSetRatio(normalizedSubject, v);
    const bumped = base + (await phoneticBoost(codesA || normalizedSubject, v));
    const score = Math.min(1, bumped);
    if (score > best) {
      best = score;
      bestVariant = v;
    }
  }
  return { score: best, matchedAlias: bestVariant };
}

// Match a subject against an array of candidate entries (already pre-filtered
// by caller — typically by first normalized token + list_source).
async function matchSubject(subject, candidates, threshold) {
  const normalized = subject.normalizedName || normalizeName(subject.name);
  const dm = await getDoubleMetaphone();
  const subjectCodes = dm(normalized);
  const out = [];
  for (const entry of candidates) {
    const { score, matchedAlias } = await scoreEntry(normalized, entry, subjectCodes);
    if (score >= threshold) {
      out.push({ entry, score, matchedAlias });
    }
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = {
  tokenSetRatio,
  ratio,
  phoneticBoost,
  scoreEntry,
  matchSubject,
  firstToken,
};
