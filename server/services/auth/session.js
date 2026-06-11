// R1 — server-side session middleware.
//
// express-session backed by Postgres (connect-pg-simple) on the existing pg
// Pool — durable, revocable, and shared across the web process and the future
// R2 worker process (same store → same identity). The httpOnly cookie is sent
// automatically by EventSource, so SSE (GET /api/stream/:threadId) authenticates
// with no special handling.
//
// connect-pg-simple creates its own `session` table at boot
// (createTableIfMissing) — no migration needed for it.
const session = require('express-session');
const pgSimple = require('connect-pg-simple');
const { pool } = require('../../db/client');

const PgStore = pgSimple(session);

// One day default; rolling so activity extends it. Kept short-ish because the
// store is server-side and cheap to refresh.
const TTL_MS = Number(process.env.SESSION_TTL_MS || 24 * 60 * 60 * 1000);

// COOKIE_SECURE must be true behind HTTPS in production. Default false so local
// http://localhost dev works; flip via .env for any real deployment.
const COOKIE_SECURE = String(process.env.COOKIE_SECURE || 'false') === 'true';

function buildSessionMiddleware() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Fail loud rather than silently using a guessable secret — a weak session
    // secret undermines the whole auth model.
    throw new Error(
      '[auth] SESSION_SECRET is not set. Add a long random value to server/.env.',
    );
  }

  return session({
    name: 'ccpoc.sid',
    store: new PgStore({
      pool,
      tableName: 'session',
      createTableIfMissing: true,
      // Sweep expired rows every 15 min.
      pruneSessionInterval: 15 * 60,
    }),
    secret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: TTL_MS,
      path: '/',
    },
  });
}

module.exports = { buildSessionMiddleware, TTL_MS, COOKIE_SECURE };
