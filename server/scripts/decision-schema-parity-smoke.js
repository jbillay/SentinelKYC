// Phase 5 / Q4 — decision schema parity smoke.
//
// server/lib/decisionSchema.js (CJS) and web/src/lib/decisionSchema.js (ESM)
// are physical twins (sharing one physical file would need bundler gymnastics
// the POC doesn't justify). This smoke compares the bits that drive
// validation parity so the two files can't silently drift.
//
// Compared:
//   - REASON_CODES array — identity and order.
//   - The list of schema/export names (approveSchema, rejectSchema, …) the
//     server file exports — every name must also appear in the web file.
//   - The min-length numbers used in each form's text fields — extracted by
//     regex from the web file so we don't need to spin up an ESM loader.

const fs = require('fs');
const path = require('path');

const server = require('../lib/decisionSchema');
const serverPath = path.join(__dirname, '..', 'lib', 'decisionSchema.js');
const webPath = path.join(__dirname, '..', '..', 'web', 'src', 'lib', 'decisionSchema.js');
const serverText = fs.readFileSync(serverPath, 'utf8');
const webText = fs.readFileSync(webPath, 'utf8');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

function extractReasonCodes(text) {
  // Matches both `const REASON_CODES = […]` (CJS) and `export const REASON_CODES = […]` (ESM).
  const m = text.match(/REASON_CODES\s*=\s*\[([\s\S]*?)\]/);
  if (!m) return null;
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function hasExport(text, name) {
  // Server uses module.exports = { name, ... }; web uses `export const name = …`.
  return (
    new RegExp(`export\\s+const\\s+${name}\\b`).test(text)
    || new RegExp(`\\b${name}\\b`).test(text)
  );
}

function minLengthFor(text, schemaName, field) {
  // Find the schema block, then the field's z.string().min(n).
  const block = text.match(
    new RegExp(`${schemaName}\\s*=\\s*z\\.object\\(\\{([\\s\\S]*?)\\}\\)`)
  );
  if (!block) return null;
  const fieldMatch = block[1].match(
    new RegExp(`${field}\\s*:\\s*z\\.string\\(\\)\\.min\\((\\d+)\\)`)
  );
  return fieldMatch ? Number(fieldMatch[1]) : null;
}

console.log('[decision:schema-parity-smoke] running');

// 1. REASON_CODES identical (and same order — order is the dropdown order in
// the UI, so it matters).
const webCodes = extractReasonCodes(webText);
ok('web REASON_CODES extracted', Array.isArray(webCodes) && webCodes.length > 0,
  webCodes ? `count=${webCodes.length}` : 'regex miss — did the file format change?');
ok('REASON_CODES length matches',
  webCodes?.length === server.REASON_CODES.length,
  `web=${webCodes?.length} server=${server.REASON_CODES.length}`);
for (let i = 0; i < server.REASON_CODES.length; i++) {
  ok(`REASON_CODES[${i}] = ${server.REASON_CODES[i]}`,
    webCodes?.[i] === server.REASON_CODES[i],
    `web=${webCodes?.[i]}`);
}

// 2. Every schema exported by the server file appears in the web file too.
const SCHEMA_NAMES = [
  'REASON_CODES',
  'reasonCodeSchema',
  'approveSchema',
  'rejectSchema',
  'escalateSchema',
  'requestInfoItemSchema',
  'requestInfoSchema',
  'decisionPayloadSchema',
];
for (const name of SCHEMA_NAMES) {
  ok(`web exports ${name}`, hasExport(webText, name));
}

// 3. Min-length numbers — both files use z.string().min(N) for the same fields.
// Text-parse each side and compare. This also surfaces if a min() is removed
// from one file but kept in the other.
const cases = [
  ['rejectSchema', 'freeText'],
  ['escalateSchema', 'notes'],
  ['requestInfoItemSchema', 'description'],
  ['requestInfoItemSchema', 'category'],
];
for (const [schemaName, field] of cases) {
  const serverMin = minLengthFor(serverText, schemaName, field);
  const webMin = minLengthFor(webText, schemaName, field);
  ok(`${schemaName}.${field} min length matches`,
    serverMin != null && serverMin === webMin,
    `server=${serverMin} web=${webMin}`);
}

// 4. Sanity-check the server schemas actually enforce what we just compared
// (catches the case where someone deletes the .min() from the server file but
// leaves the string in place — text parity would pass but the schema wouldn't
// reject short input).
{
  const r = server.rejectSchema.safeParse({
    action: 'reject',
    userId: 'tester',
    reasonCode: 'other',
    freeText: 'short',
  });
  ok('server rejectSchema enforces freeText min', r.success === false);
}
{
  const r = server.requestInfoItemSchema.safeParse({ description: 'no', category: '' });
  ok('server requestInfoItemSchema enforces minimums', r.success === false);
}

console.log('[decision:schema-parity-smoke] done');
