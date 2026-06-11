// OFAC SDN Enhanced XML parser.
//
// The publication served at sanctionslistservice.ofac.treas.gov uses the
// "ENHANCED_XML" schema, where each record is a <sanctionsData><entities><entity>
// with structured <names>, <features>, <sanctionsPrograms>, etc. Parsed in
// one shot via fast-xml-parser — file is ~100 MB, acceptable on dev hardware.
// Swap in `sax` for true streaming if memory becomes a problem.
//
// Yields: { list_entry_id, entry_type, primary_name, normalized_name,
//           aliases, dob, nationality, identifiers, programs, raw }

const { XMLParser } = require('fast-xml-parser');
const { normalizeName } = require('../normalize');

const PARSER = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) =>
    [
      'entity',
      'name',
      'translation',
      'feature',
      'sanctionsProgram',
      'sanctionsList',
      'sanctionsType',
      'legalAuthority',
      'address',
      'namePart',
      'addressPart',
    ].includes(name),
});

function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node.trim();
  if (typeof node === 'object') {
    if ('#text' in node) return String(node['#text']).trim();
  }
  return '';
}

function entryTypeOf(entityTypeText) {
  const t = (entityTypeText || '').trim().toLowerCase();
  if (t === 'individual') return 'individual';
  if (t === 'entity') return 'entity';
  if (t === 'vessel' || t === 'aircraft') return 'entity';
  return 'unknown';
}

function pickFormattedName(name) {
  // Prefer the Latin-script primary translation; fall back to first.
  const translations = asArray(name?.translations?.translation);
  let primary = translations.find(
    (t) => textOf(t.isPrimary) === 'true' && textOf(t.script) === 'Latin',
  );
  if (!primary) primary = translations.find((t) => textOf(t.script) === 'Latin');
  if (!primary) primary = translations[0];
  if (!primary) return '';
  if (primary.formattedFullName) return textOf(primary.formattedFullName);
  // Reconstruct from name parts as a fallback
  const parts = asArray(primary?.nameParts?.namePart)
    .map((p) => textOf(p?.value))
    .filter(Boolean);
  return parts.join(' ');
}

function buildNames(entity) {
  const names = asArray(entity?.names?.name);
  let primary = '';
  const aliases = [];
  for (const n of names) {
    const formatted = pickFormattedName(n);
    if (!formatted) continue;
    if (textOf(n.isPrimary) === 'true' && !primary) {
      primary = formatted;
    } else {
      aliases.push({
        name: formatted,
        normalized: normalizeName(formatted),
        type: textOf(n.aliasType) || undefined,
      });
    }
  }
  if (!primary && aliases.length) {
    // Some entities only carry aliases; promote the first as primary.
    const first = aliases.shift();
    primary = first.name;
  }
  return { primary, aliases };
}

function buildPrograms(entity) {
  const out = [];
  for (const p of asArray(entity?.sanctionsPrograms?.sanctionsProgram)) {
    const t = textOf(p);
    if (t) out.push(t);
  }
  return out.length ? out : undefined;
}

function buildFeatureMap(entity) {
  // Group features by type text. Each yields an array of values (text +
  // optional date range) so the caller can pick the most useful one.
  const features = asArray(entity?.features?.feature);
  const byType = new Map();
  for (const f of features) {
    const t = textOf(f.type);
    if (!t) continue;
    if (!byType.has(t)) byType.set(t, []);
    byType.get(t).push({ value: textOf(f.value), date: f.valueDate, raw: f });
  }
  return byType;
}

function buildDob(features) {
  const dates = features.get('Birthdate') || features.get('Date of Birth') || [];
  if (!dates.length) return undefined;
  const d = dates[0];
  if (d?.date?.fromDateBegin) return textOf(d.date.fromDateBegin);
  return d.value || undefined;
}

function buildNationality(features) {
  const out = new Set();
  for (const key of ['Nationality Country', 'Citizenship Country', 'Citizenship']) {
    for (const f of features.get(key) || []) {
      if (f.value) out.add(f.value);
    }
  }
  return out.size ? [...out] : undefined;
}

const IDENTIFIER_KEYS = new Set([
  'Passport',
  'Passport Number',
  'National ID',
  'National ID No.',
  'National Identification Number',
  'Cedula No.',
  'SSN',
  'Driver License No.',
  'Tax ID No.',
  'Registration Number',
  'Business Registration Document',
]);

function buildIdentifiers(features) {
  const out = [];
  for (const [type, values] of features) {
    if (!IDENTIFIER_KEYS.has(type)) continue;
    for (const v of values) {
      if (v.value) out.push({ type, value: v.value });
    }
  }
  return out.length ? out : undefined;
}

function* iterEntries(xmlText) {
  const parsed = PARSER.parse(xmlText);
  const root = parsed?.sanctionsData || parsed?.sdnList || parsed;
  const entities = asArray(root?.entities?.entity || root?.entity);
  for (const e of entities) {
    const id = e['@_id'] || e.id;
    if (id == null) continue;
    const { primary, aliases } = buildNames(e);
    if (!primary) continue;
    const features = buildFeatureMap(e);
    yield {
      list_entry_id: String(id),
      entry_type: entryTypeOf(textOf(e?.generalInfo?.entityType)),
      primary_name: primary,
      normalized_name: normalizeName(primary),
      aliases,
      dob: buildDob(features),
      nationality: buildNationality(features),
      identifiers: buildIdentifiers(features),
      programs: buildPrograms(e),
      raw: e,
    };
  }
}

module.exports = { iterEntries };
