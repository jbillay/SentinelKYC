// P1 C1 — umbrella config-drift parity runner (`npm run parity`).
//
// Runs all three "physical/behavioural twin" checks in one pass:
//   1. decision schema   — server/lib/decisionSchema.js ↔ web ESM twin
//   2. party-match schema — server/lib/partyMatchSchema.js ↔ web ESM twin
//   3. name_canonical     — services/party/canonical.js ↔ SQL function (DB)
//
// There is no CI server in the POC — this IS the CI: run it manually before
// touching any twin (CLAUDE.md convention). Exit code 1 on any drift.

const { pool } = require('../db/client');

async function main() {
  const results = [];

  async function phase(name, fn) {
    const before = process.exitCode;
    process.exitCode = 0;
    try {
      await fn();
    } catch (err) {
      console.error(`  ✗ ${name} threw:`, err.message);
      process.exitCode = 1;
    }
    const failed = process.exitCode === 1;
    results.push({ name, failed });
    // Preserve any earlier failure.
    process.exitCode = failed || before === 1 ? 1 : 0;
  }

  // 1. Decision schema twin — the script is all top-level code; requiring it
  // runs it. Wrap so its console output groups under this phase.
  await phase('decision-schema', async () => {
    require('./decision-schema-parity-smoke');
  });

  // 2. Party-match schema twin.
  await phase('party-match-schema', async () => {
    require('./party-match-schema-parity-smoke').run();
  });

  // 3. Canonical behavioural twin (needs DATABASE_URL + migration 0012+).
  await phase('canonical', async () => {
    await require('./canonical-parity-smoke').run();
  });

  const failed = results.filter((r) => r.failed).map((r) => r.name);
  if (failed.length === 0) {
    console.log(`parity: ${results.length}/${results.length} OK`);
  } else {
    console.log(`parity: FAILED — ${failed.join(', ')}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('[config-parity-smoke] fatal:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
