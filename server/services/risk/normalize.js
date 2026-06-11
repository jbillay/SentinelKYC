// Risk-input normalization.
//
// `normalizeCountry` is async because of the R4 LLM fallback: a free-text
// country that is not in the static lookup table is resolved once via the
// reasoning model and cached in dev-cache.db (kv namespace 'risk_country').
// The lookup path (the overwhelmingly common case) does no I/O at all — it
// does not even open the SQLite cache or load the Ollama client — so the pure
// engine and its smoke stay side-effect-free.

const crypto = require('crypto');
const { z } = require('zod');

const COUNTRY_LOOKUP = require('./data/country-lookup.json');
const { log } = require('../log');

const CountryNormSchema = z.object({ iso2: z.string().nullable() });

function normKey(raw) {
  return String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function isIso2(v) {
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v.trim());
}

// Returns { iso2: string|null, label: string|null,
//           source: 'lookup' | 'llm-cached' | 'llm' | 'unknown' }.
async function normalizeCountry(rawCountry) {
  const key = normKey(rawCountry);
  if (!key) return { iso2: null, label: null, source: 'unknown' };

  const direct = COUNTRY_LOOKUP[key];
  if (direct) return { iso2: direct, label: rawCountry, source: 'lookup' };

  // --- miss: kv cache, then LLM, then give up --------------------------------
  let cache = null;
  try {
    cache = require('../cache');
  } catch {
    cache = null;
  }
  const cacheKey = crypto.createHash('sha256').update(key).digest('hex');

  if (cache) {
    const cached = cache.kvGet('risk_country', cacheKey);
    if (cached && isIso2(cached.iso2)) {
      return { iso2: cached.iso2.trim().toUpperCase(), label: rawCountry, source: 'llm-cached' };
    }
  }

  try {
    const { extractStructured } = require('../llm');
    const { loadPrompt } = require('../prompts');
    const prompt = await loadPrompt('risk.normalize_country');
    const out = await extractStructured(String(rawCountry), CountryNormSchema, prompt);
    if (out && isIso2(out.iso2)) {
      const iso2 = out.iso2.trim().toUpperCase();
      if (cache) cache.kvSet('risk_country', cacheKey, { iso2 });
      return { iso2, label: rawCountry, source: 'llm' };
    }
  } catch (err) {
    // Ollama down / parse failure / prompt-load failure — leave it unknown.
    log.warn(`[risk] country LLM normalize failed for "${rawCountry}": ${err.message}`);
  }

  return { iso2: null, label: rawCountry, source: 'unknown' };
}

// Companies House `company_type` values are already lowercase slugs (`ltd`,
// `plc`, `private-limited-guarant-nsc`, …). This is mostly a defensive
// pass-through with a small alias map for the occasional human-readable form.
const ENTITY_TYPE_ALIASES = {
  'private limited company': 'ltd',
  'private company limited by shares': 'ltd',
  'limited company': 'ltd',
  'public limited company': 'plc',
  'limited liability partnership': 'llp',
  'limited partnership': 'limited-partnership',
  'community interest company': 'community-interest-company',
};

function normalizeEntityType(profileType) {
  const raw = normKey(profileType);
  if (!raw) return null;
  return ENTITY_TYPE_ALIASES[raw] || raw;
}

function normalizeSicCodes(profile) {
  const codes = profile && profile.sic_codes;
  if (!Array.isArray(codes)) return [];
  return codes
    .map((c) => String(c == null ? '' : c).trim())
    .filter((c) => c.length > 0);
}

module.exports = { normKey, normalizeCountry, normalizeEntityType, normalizeSicCodes };
