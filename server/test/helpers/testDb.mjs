// Test helper — real-Postgres harness for the integration tier.
//
// The integration tests (Phase 3+) run against the SAME Postgres service the CI
// `server-db` job already provisions. db/client.js throws when DATABASE_URL is
// unset, so everything here loads it LAZILY and exposes `hasDb` + a
// `describeIntegration` wrapper that skips cleanly on a developer machine with
// no database — the suite is silently skipped, never failed.
// See docs/architecture/TEST_STRATEGY.md §5.4.
import { describe } from 'vitest';

export const hasDb = !!process.env.DATABASE_URL;

let _client = null;
/** Lazily require db/client (CJS) only when a DATABASE_URL exists. */
export async function getDb() {
  if (!hasDb) throw new Error('testDb.getDb(): DATABASE_URL is not set');
  if (!_client) {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    _client = require('../../db/client.js');
  }
  return _client; // { db, pool, schema }
}

/**
 * describe() that auto-skips when no DATABASE_URL is present. Use for every
 * integration suite so `npm run test:unit` stays green without a database, and
 * the same files run for real in CI.
 */
export const describeIntegration = hasDb ? describe : describe.skip;

/**
 * Truncate the mutable application tables between suites. Order respects FKs via
 * CASCADE. Reference data (sanctions lists, risk matrix, prompts, users) is left
 * intact — seed it once per suite if a test needs it.
 */
export async function truncateRunData() {
  const { pool } = await getDb();
  await pool.query(`
    TRUNCATE TABLE
      decision_fragments, screening_evaluations, screening_hits,
      run_events, runs, dossiers,
      party_link_status_history, party_links, party_review_queue,
      party_match_log, party_screening_overrides, party_watchlist, parties
    RESTART IDENTITY CASCADE
  `);
}

/** Close the pool — call in an afterAll so vitest can exit cleanly. */
export async function closeDb() {
  if (_client?.pool) await _client.pool.end();
  _client = null;
}
