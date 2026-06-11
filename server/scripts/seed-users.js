// R1 — seed the initial user set.
//
// Idempotent: re-running upserts (rotates password / role / active) so this is
// safe to run repeatedly. Credentials are NEVER hard-coded — each user's
// initial password is read from .env:
//
//   SEED_ANALYST_PASSWORD   → user "analyst"  (role analyst)
//   SEED_REVIEWER_PASSWORD  → user "reviewer" (role reviewer)
//   SEED_ADMIN_PASSWORD     → user "admin"    (role admin)
//
// A user whose env password is absent is skipped with a warning (so a partial
// .env still seeds what it can). Run: `npm run users:seed`.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { pool } = require('../db/client');
const repo = require('../db/repo');
const { hashPassword } = require('../services/auth/passwords');

const SEED = [
  { username: 'analyst', displayName: 'Analyst User', role: 'analyst', envKey: 'SEED_ANALYST_PASSWORD' },
  { username: 'reviewer', displayName: 'Reviewer User', role: 'reviewer', envKey: 'SEED_REVIEWER_PASSWORD' },
  { username: 'admin', displayName: 'Admin User', role: 'admin', envKey: 'SEED_ADMIN_PASSWORD' },
];

async function main() {
  let seeded = 0;
  let skipped = 0;
  for (const u of SEED) {
    const pw = process.env[u.envKey];
    if (!pw) {
      console.warn(`  - skip "${u.username}" — ${u.envKey} not set in .env`);
      skipped += 1;
      continue;
    }
    const passwordHash = await hashPassword(pw);
    const row = await repo.upsertUser({
      username: u.username,
      displayName: u.displayName,
      passwordHash,
      role: u.role,
      active: true,
    });
    console.log(`  ✓ ${row.username} (${row.role})`);
    seeded += 1;
  }
  console.log(`[users:seed] done — ${seeded} seeded, ${skipped} skipped`);
}

main()
  .catch((err) => {
    console.error('[users:seed] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
