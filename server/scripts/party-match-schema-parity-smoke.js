// P1 C1 — partyMatchSchema twin parity smoke.
//
// server/lib/partyMatchSchema.js (CJS) and web/src/lib/partyMatchSchema.js
// (ESM) are physical twins — identical apart from the module wrapper. This
// smoke mirrors decision-schema-parity-smoke.js: text-extract the bits that
// drive validation parity and compare, plus a live safeParse sanity check on
// the server side.

const fs = require('fs');
const path = require('path');

const server = require('../lib/partyMatchSchema');
const serverPath = path.join(__dirname, '..', 'lib', 'partyMatchSchema.js');
const webPath = path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'partyMatchSchema.js');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

function extractEnums(text) {
  // Every z.enum([...]) literal, as a sorted list of member-lists.
  const out = [];
  const re = /z\.enum\(\[([^\]]*)\]\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(
      m[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .join('|')
    );
  }
  return out.sort();
}

function extractMinMax(text) {
  // Every .min(N) / .max(N) numeric literal, multiset-compared as sorted lists.
  const mins = [...text.matchAll(/\.min\((\d+)[,)]/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  const maxs = [...text.matchAll(/\.max\((\d+)\)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
  return { mins, maxs };
}

function run() {
  console.log('[party-match-schema-parity-smoke] running');

  if (!fs.existsSync(webPath)) {
    ok('web twin exists', false, webPath);
    return;
  }
  const serverText = fs.readFileSync(serverPath, 'utf8');
  const webText = fs.readFileSync(webPath, 'utf8');

  // 1. Every name the server file exports appears in the web file.
  const exportNames = Object.keys(server);
  for (const name of exportNames) {
    const present =
      new RegExp(`export\\s+const\\s+${name}\\b`).test(webText) || new RegExp(`\\b${name}\\b`).test(webText);
    ok(`web exports ${name}`, present);
  }

  // 2. Enum member lists agree (confidence bands, matchedVia, action literals).
  const serverEnums = extractEnums(serverText);
  const webEnums = extractEnums(webText);
  ok(
    'z.enum member lists agree',
    JSON.stringify(serverEnums) === JSON.stringify(webEnums),
    `server=${JSON.stringify(serverEnums)} web=${JSON.stringify(webEnums)}`
  );

  // 3. min()/max() literals agree as multisets (field-order agnostic, catches
  // a loosened bound on one side).
  const s = extractMinMax(serverText);
  const w = extractMinMax(webText);
  ok('min() literals agree', JSON.stringify(s.mins) === JSON.stringify(w.mins), `server=${s.mins} web=${w.mins}`);
  ok('max() literals agree', JSON.stringify(s.maxs) === JSON.stringify(w.maxs), `server=${s.maxs} web=${w.maxs}`);

  // 4. Live sanity check — the server schema actually enforces what we compared.
  {
    const r = server.partyMatchInputSchema.safeParse({ name: '' });
    ok('server partyMatchInputSchema rejects empty name', r.success === false);
  }
  {
    const r = server.partyMatchInputSchema.safeParse({ name: 'Jane Doe', nationality: ['GBR'] });
    ok('server partyMatchInputSchema rejects non-ISO2 nationality', r.success === false);
  }
  {
    const r = server.partyMergeSchema.safeParse({ mergeFromPartyId: 'not-a-uuid' });
    ok('server partyMergeSchema rejects non-uuid', r.success === false);
  }

  console.log('[party-match-schema-parity-smoke] done');
}

module.exports = { run };

if (require.main === module) run();
