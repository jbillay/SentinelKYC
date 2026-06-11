// UK HMT (OFSI) Consolidated List — CSV format.
//
// HMT publishes the list with one row per (Group ID, Alias). All aliases of
// the same designated person share a Group ID; one row carries the primary
// name (Alias Type = "Primary name"), others carry AKAs.
//
// The CSV has ~30 columns whose names vary between years. The parser below
// is tolerant: it does case-insensitive header matching with a small set of
// candidates per logical field. If a column we don't yet recognise turns up,
// we keep going — the matcher only needs primary_name + aliases anyway.
//
// Yields: { list_entry_id, entry_type, primary_name, aliases, dob,
//           nationality, identifiers, programs, raw }

const Papa = require('papaparse');
const { normalizeName } = require('../normalize');

function pickHeader(headers, candidates) {
  const lc = headers.map((h) => (h || '').trim().toLowerCase());
  for (const c of candidates) {
    const ix = lc.indexOf(c.toLowerCase());
    if (ix !== -1) return headers[ix];
  }
  return null;
}

function buildHeaderMap(headers) {
  return {
    groupId: pickHeader(headers, ['Group ID', 'GroupID']),
    aliasType: pickHeader(headers, ['Alias Type', 'AliasType']),
    groupType: pickHeader(headers, ['Group Type', 'GroupType']),
    name1: pickHeader(headers, ['Name 1', 'Name1']),
    name2: pickHeader(headers, ['Name 2', 'Name2']),
    name3: pickHeader(headers, ['Name 3', 'Name3']),
    name4: pickHeader(headers, ['Name 4', 'Name4']),
    name5: pickHeader(headers, ['Name 5', 'Name5']),
    name6: pickHeader(headers, ['Name 6', 'Name6']),
    title: pickHeader(headers, ['Title']),
    dob: pickHeader(headers, ['DOB', 'Date of Birth']),
    nationality: pickHeader(headers, ['Nationality']),
    passport: pickHeader(headers, ['Passport Number', 'Passport Details']),
    ni: pickHeader(headers, ['NI Number', 'National Insurance']),
    regime: pickHeader(headers, ['Regime']),
    listedOn: pickHeader(headers, ['Listed On']),
    lastUpdated: pickHeader(headers, ['Last Updated']),
  };
}

function buildName(row, h) {
  const parts = [
    row[h.name1],
    row[h.name2],
    row[h.name3],
    row[h.name4],
    row[h.name5],
    row[h.name6],
  ]
    .map((s) => (s == null ? '' : String(s).trim()))
    .filter(Boolean);
  return parts.join(' ').trim();
}

function entryTypeOf(value) {
  const v = (value || '').trim().toLowerCase();
  if (v === 'individual') return 'individual';
  if (v === 'entity') return 'entity';
  return 'unknown';
}

function isPrimary(aliasType) {
  if (!aliasType) return true; // some sheets omit alias_type for primaries
  return /primary/i.test(String(aliasType));
}

function stripBanner(csvText) {
  // OFSI prepends a single banner row like `Last Updated,27/01/2026` before
  // the actual column-name row. If the first comma-separated cell of the
  // first line is "Last Updated" but the row has only 2 cells, drop it.
  const nl = csvText.indexOf('\n');
  if (nl === -1) return csvText;
  const firstLine = csvText.slice(0, nl).replace(/\r$/, '');
  const cells = firstLine.split(',');
  if (cells.length <= 3 && /^last updated$/i.test(cells[0].trim())) {
    return csvText.slice(nl + 1);
  }
  return csvText;
}

function parseCsv(csvText) {
  const result = Papa.parse(stripBanner(csvText), {
    header: true,
    skipEmptyLines: true,
  });
  return result.data || [];
}

function* iterEntries(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const h = buildHeaderMap(headers);

  if (!h.groupId) {
    throw new Error('uk_hmt_csv: could not locate Group ID column in header');
  }

  // Group by Group ID
  const groups = new Map();
  for (const row of rows) {
    const gid = String(row[h.groupId] || '').trim();
    if (!gid) continue;
    if (!groups.has(gid)) groups.set(gid, []);
    groups.get(gid).push(row);
  }

  for (const [gid, group] of groups) {
    let primary = group.find((r) => isPrimary(r[h.aliasType]));
    if (!primary) primary = group[0];
    const primaryName = buildName(primary, h);
    if (!primaryName) continue;

    const aliases = [];
    for (const r of group) {
      if (r === primary) continue;
      const n = buildName(r, h);
      if (!n) continue;
      aliases.push({
        name: n,
        normalized: normalizeName(n),
        type: r[h.aliasType] || undefined,
      });
    }

    const programsSet = new Set();
    const nationality = new Set();
    const identifiers = [];
    let dob;
    for (const r of group) {
      if (h.regime && r[h.regime]) {
        for (const piece of String(r[h.regime]).split(/[;|,]/)) {
          const p = piece.trim();
          if (p) programsSet.add(p);
        }
      }
      if (h.nationality && r[h.nationality]) {
        for (const piece of String(r[h.nationality]).split(/[;|,]/)) {
          const p = piece.trim();
          if (p) nationality.add(p);
        }
      }
      if (h.passport && r[h.passport]) {
        identifiers.push({ type: 'passport', value: String(r[h.passport]).trim() });
      }
      if (h.ni && r[h.ni]) {
        identifiers.push({ type: 'ni_number', value: String(r[h.ni]).trim() });
      }
      if (!dob && h.dob && r[h.dob]) {
        dob = String(r[h.dob]).trim();
      }
    }

    yield {
      list_entry_id: gid,
      entry_type: entryTypeOf(primary[h.groupType]),
      primary_name: primaryName,
      normalized_name: normalizeName(primaryName),
      aliases,
      dob: dob || undefined,
      nationality: nationality.size ? [...nationality] : undefined,
      identifiers: identifiers.length ? identifiers : undefined,
      programs: programsSet.size ? [...programsSet] : undefined,
      raw: { primary, aliasRows: group.length },
    };
  }
}

module.exports = { iterEntries };
