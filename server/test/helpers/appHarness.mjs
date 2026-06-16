// Integration harness — mounts the REAL Express app (buildApp) against a test
// Postgres, with auth via the dev bypass and the external boundaries left to
// per-test mocks. See docs/architecture/TEST_STRATEGY.md §6.4.
//
// SAFETY: integration tests gate on TEST_DATABASE_URL, never the dev DATABASE_URL
// — they TRUNCATE tables, so they must point at a throwaway DB. When unset, the
// suite is skipped (describeIntegration → describe.skip). CI sets it to the
// Postgres service DB; locally: create kyc_poc_test, migrate it, and export
// TEST_DATABASE_URL before running vitest.
import { describe } from 'vitest';
import { createRequire } from 'node:module';

const TEST_DB = process.env.TEST_DATABASE_URL || null;
export const hasTestDb = !!TEST_DB;
export const describeIntegration = hasTestDb ? describe : describe.skip;

// Point everything at the test DB and switch on the bypass BEFORE any module
// that reads these at require-time (db/client, services/auth, services/ch).
if (TEST_DB) {
  process.env.DATABASE_URL = TEST_DB;
  process.env.AUTH_DEV_BYPASS = 'true';
  process.env.LLM_BOOT_CHECK = 'warn';
  process.env.SESSION_SECRET ||= 'integration-test-session-secret';
  process.env.CONFIG_ENCRYPTION_KEY ||= '0'.repeat(64); // 32-byte hex for AES-256-GCM
  process.env.CH_API_KEY ||= 'test-ch-key';
  // Point the LLM at a dead port so any reasoning/OCR call fails FAST
  // (ECONNREFUSED) instead of hitting a real local Ollama (a dev .env sets
  // OLLAMA_HOST, so this must be an UNCONDITIONAL override, like DATABASE_URL).
  // Routes that use the LLM (e.g. recalculate-risk) then exercise their
  // documented template/error fallback deterministically and offline.
  // SET (don't delete) every provider var: a later dotenv.config() fills UNSET
  // vars, so deleting LLM_REASONING_PROVIDER would let the dev .env's `nvidia`
  // creep back in. Forcing them to 'ollama' + a dead host makes any LLM call
  // fail fast regardless of .env.
  process.env.LLM_PROVIDER = 'ollama';
  process.env.LLM_OCR_PROVIDER = 'ollama';
  process.env.LLM_REASONING_PROVIDER = 'ollama';
  process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
}

const require = createRequire(import.meta.url);

let _app = null;
let _repo = null;
let _supertest = null;

export function getRepo() {
  return (_repo ||= require('../../db/repo'));
}

export function getPool() {
  return require('../../db/client').pool;
}

function getApp() {
  if (!_app) _app = require('../../index.js').buildApp();
  return _app;
}

/** A supertest request bound to the app. */
export async function api() {
  if (!_supertest) _supertest = (await import('supertest')).default;
  return _supertest(getApp());
}

/**
 * A persistent supertest agent that carries cookies between requests.
 * Required for the CSRF flow: first GET /api/auth/csrf to get the token
 * (and set the session cookie), then POST with x-csrf-token header.
 */
export async function createAgent() {
  if (!_supertest) _supertest = (await import('supertest')).default;
  return _supertest.agent(getApp());
}

/** Attach the dev-bypass admin identity (x-user-id ⇒ admin, CSRF skipped). */
export function asAdmin(req, userId = 'test-admin') {
  return req.set('x-user-id', userId);
}

/** Seed the reference data GET routes expect (prompts, agent config, risk matrix). */
export async function seedReference() {
  const { seedPrompts } = require('../../services/prompts');
  const { seedAgentConfigs } = require('../../agents/config');
  const { seedRiskMatrix } = require('../../services/risk/seed');
  await seedPrompts();
  await seedAgentConfigs();
  await seedRiskMatrix();
}

/** Truncate the mutable application tables between tests (FK-safe via CASCADE). */
export async function truncateRunData() {
  await getPool().query(`
    TRUNCATE TABLE
      decision_fragments, screening_evaluations, screening_hits,
      run_events, runs, dossiers,
      party_link_status_history, party_links, party_review_queue,
      party_match_log, party_screening_overrides, party_watchlist, parties
    RESTART IDENTITY CASCADE
  `);
}

/** Close the pool so vitest can exit cleanly (call in afterAll). */
export async function closePool() {
  if (_repo || _app) await getPool().end();
}
