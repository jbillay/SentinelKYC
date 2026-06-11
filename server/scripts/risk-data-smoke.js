// Phase 3 / R1 — risk data-foundation smoke.
// Verifies: migration applied, default matrix seeded as v1, getActiveRiskMatrix
// returns it, validateMatrix rejects a bad body, country lookup hits + misses.
//
// Run after `npm run db:migrate`. Seeds the matrix itself (idempotent) since
// the server boot is not running here.

const { sql } = require('drizzle-orm');
const { db, pool } = require('../db/client');
const repo = require('../db/repo');
const matrix = require('../services/risk/matrix');
const { seedRiskMatrix } = require('../services/risk/seed');
const countryLookup = require('../services/risk/data/country-lookup.json');

function normCountry(raw) {
  return String(raw || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log('[risk:data-smoke] seeding matrix (idempotent)');
  await seedRiskMatrix();

  // 1. migration applied — tables + column exist
  const tablesRow = await db.execute(sql`
    select
      to_regclass('public.risk_matrix_versions') is not null as versions_tbl,
      to_regclass('public.risk_matrix_active')   is not null as active_tbl
  `);
  const colRow = await db.execute(sql`
    select count(*)::int as n
    from information_schema.columns
    where table_name = 'runs' and column_name = 'final_risk_assessment'
  `);
  const migrationOk =
    tablesRow.rows?.[0]?.versions_tbl === true &&
    tablesRow.rows?.[0]?.active_tbl === true &&
    (colRow.rows?.[0]?.n ?? 0) === 1;
  ok('migration applied (tables + runs.final_risk_assessment column)', migrationOk);

  // 2. default matrix seeded as v1
  const v1Row = await db.execute(sql`
    select version, notes from risk_matrix_versions where version = 1 limit 1
  `);
  const v1 = v1Row.rows?.[0];
  ok('default matrix seeded as v1', !!v1, v1 ? `notes="${v1.notes}"` : 'no v1 row');

  // 3. getActiveRiskMatrix() returns the seeded v1
  const active = await repo.getActiveRiskMatrix();
  const activeOk =
    !!active &&
    active.version === 1 &&
    active.body &&
    typeof active.body === 'object' &&
    active.body.weights &&
    Math.abs(
      Object.values(active.body.weights).reduce((a, b) => a + b, 0) - 1
    ) < 0.001;
  ok('getActiveRiskMatrix() returns v1 with valid weights', activeOk,
     active ? `version=${active.version} versionId=${active.versionId}` : 'null');

  // 3b. the seeded body passes validateMatrix (sanity on our own default)
  const seedErrors = matrix.validateMatrix(active?.body);
  ok('seeded matrix body passes validateMatrix', seedErrors.length === 0,
     seedErrors.length ? seedErrors.join('; ') : '');

  // 4. validateMatrix rejects a bad body (weights sum != 1)
  const badBody = JSON.parse(JSON.stringify(active?.body || matrix.defaultMatrixBody()));
  badBody.weights.geographic = 0.5; // breaks the sum
  const badErrors = matrix.validateMatrix(badBody);
  const rejectsBad = badErrors.length > 0 && badErrors.some((e) => /weights_sum|sum to 1/i.test(e));
  ok('validateMatrix rejects bad body (weights sum != 1)', rejectsBad,
     badErrors.join('; '));

  // 5. country lookup hits 'United Kingdom' -> 'GB'
  const hit = countryLookup[normCountry('United Kingdom')];
  ok("country lookup: 'United Kingdom' -> 'GB'", hit === 'GB', `got=${hit}`);

  // 6. country lookup misses on garbage input
  const miss = countryLookup[normCountry('Zzqq Notacountry 999')];
  ok('country lookup: garbage input -> undefined', miss === undefined, `got=${miss}`);

  console.log('[risk:data-smoke] done');
}

main()
  .catch((err) => {
    console.error('[risk:data-smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
