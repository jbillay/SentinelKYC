// P1 C1 — canonical-function parity smoke (behavioural differential test).
//
// services/party/canonical.js (JS) and the SQL name_canonical() (migration
// 0012) are behavioural twins: the matcher writes/queries the SQL-generated
// parties.name_canonical column, while the graph rewrite canonicalises labels
// in JS. If the two drift, party dedup silently corrupts (a surface form
// misses its party and renders as a duplicate node).
//
// This smoke feeds a fixed table of adversarial names through BOTH
// implementations and asserts string equality. Behavioural twins get a
// differential test, not a text diff. Requires DATABASE_URL (same
// precondition as every other DB smoke) and a migrated DB (0012+).

const { pool } = require('../db/client');
const { nameCanonical } = require('../services/party/canonical');

// Honorifics, suffixes, punctuation, unicode, casing, whitespace, token
// reordering, and empty-ish degenerate inputs. Add rows freely — every row is
// cheap (one SELECT each).
const CASES = [
  // Honorifics — stand-alone tokens, with/without dot, any case.
  'Mr Vincent Huard',
  'MRS. Jane Doe',
  'Dr. John Watson',
  'Sir Arthur Conan Doyle',
  'Prof Albert Einstein',
  'Mme Marie Curie',
  'Mlle Amélie Poulain',
  'M. Jean Dupont',
  'Mr. Mr Smith', // doubled honorific
  'Mary Morten', // honorific-prefix lookalikes must survive
  'Drake Drummond', // 'dr' prefix inside a word must survive
  // Suffixes / corporate forms (NOT stripped — must round-trip identically).
  'ACME LTD',
  'Acme Limited',
  'A.C.M.E. L.T.D.',
  'Widgets PLC',
  'Lawyers LLP',
  // Punctuation.
  "Patrick O'Brien",
  'Sarah Smith-Jones',
  'J. P. Morgan',
  'Smith, John (Junior)',
  'AT&T Services',
  // Unicode / diacritics.
  'Müller GmbH',
  'José García',
  'Łukasz Kowalski',
  'Renée Façade',
  'ÅSA ÖSTLUND',
  'Søren Kjærgaard', // ø + æ — NFD-unfoldable, needs the unaccent supplement
  'Straße Holding', // ß → ss
  'Œuvre Þórsson', // ligature + thorn
  // Casing + whitespace.
  'jOhN sMiTh',
  '  Leading Spaces',
  'Trailing Spaces   ',
  'Double  Internal   Spaces',
  '\tTabbed\tName\t',
  // Token reordering (canonical sorts tokens — both sides must agree).
  'Billay Jeremy',
  'Jeremy Billay',
  // Degenerate inputs.
  '',
  '   ',
  'Mr.',
  "''",
  '123 456',
];

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log('[canonical-parity-smoke] running', `${CASES.length} cases`);
  let mismatches = 0;
  for (const input of CASES) {
    const js = nameCanonical(input);
    let sql;
    try {
      const { rows } = await pool.query('SELECT name_canonical($1) AS c', [input]);
      sql = rows[0]?.c ?? '';
    } catch (err) {
      console.error('  ✗ SQL call failed — is the DB migrated to 0012+?', err.message);
      process.exitCode = 1;
      return;
    }
    // SQL returns '' for blank input via coalesce; JS returns ''. Normalise
    // null → '' so a future SQL NULL doesn't false-fail on representation.
    const sqlNorm = sql == null ? '' : sql;
    const match = js === sqlNorm;
    if (!match) {
      mismatches += 1;
      ok(`"${input}"`, false, `js="${js}" sql="${sqlNorm}"`);
    }
  }
  ok(`all ${CASES.length} canonical cases agree`, mismatches === 0, mismatches ? `${mismatches} mismatch(es)` : '');
  console.log('[canonical-parity-smoke] done');
}

// Export for the umbrella runner; run standalone when invoked directly.
module.exports = { run: main, CASES };

if (require.main === module) {
  main()
    .catch((err) => {
      console.error('[canonical-parity-smoke] fatal:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
