// CODE_REVIEW §6.4 — smoke aggregator.
//
// ~30 smoke scripts and nothing that runs them means stale smokes rot unseen
// (known failure mode in this repo). This runner executes them in tiers:
//
//   node-only (default, `npm test`)  — no Postgres, no LLM, no network.
//   --db                             — adds smokes that need Postgres only.
//   --full                           — adds smokes that need LLM providers /
//                                      Companies House / a booted app too.
//
// Sequential, fail-fast off, summary at the end, exit 1 on any failure.
// Keep the tier lists honest: a smoke that grows a DB dependency moves down.
const { spawnSync } = require('child_process');
const path = require('path');

const TIERS = {
  node: [
    'eval-score-smoke.js',
    'decision-schema-parity-smoke.js',
    'qa-engine-smoke.js',
    'risk-engine-smoke.js',
    'agents-assemble-smoke.js',
  ],
  db: [
    'config-parity-smoke.js',
    'db-smoke.js',
    'match-smoke.js',
    'party-resolver-smoke.js',
    'party-corroboration-smoke.js',
    'party-graph-smoke.js',
    'qa-data-smoke.js',
    'decision-smoke.js',
    'screening-rekey-smoke.js',
    'queue-smoke.js',
  ],
  full: [
    'auth-smoke.js',
    'llm-smoke.js',
    'screening-smoke.js',
    'qa-integration-smoke.js',
    'graph-resolver-smoke.js',
    'eval-smoke.js',
  ],
};

function main() {
  const args = new Set(process.argv.slice(2));
  const scripts = [...TIERS.node];
  if (args.has('--db') || args.has('--full')) scripts.push(...TIERS.db);
  if (args.has('--full')) scripts.push(...TIERS.full);

  const results = [];
  for (const script of scripts) {
    const file = path.join(__dirname, script);
    console.log(`\n──── ${script} ────`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [file], { stdio: 'inherit', env: process.env });
    results.push({ script, ok: r.status === 0, ms: Date.now() - t0 });
  }

  console.log('\n════ smoke summary ════');
  let failed = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.script} (${(r.ms / 1000).toFixed(1)}s)`);
    if (!r.ok) failed += 1;
  }
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main();
