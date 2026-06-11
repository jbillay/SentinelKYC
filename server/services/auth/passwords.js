// R1 — password hashing.
//
// bcryptjs (pure JS, zero native deps) is chosen deliberately to match the
// @napi-rs/canvas decision elsewhere in the repo — no native build step on
// Windows. Cost factor 12 is a sensible 2020s default for an interactive login.
//
// Invariant: plaintext passwords are NEVER logged and never leave this module.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COST = Number(process.env.BCRYPT_COST || 12);

// A REAL bcrypt hash of a random throwaway secret, generated at boot. Used by
// the login route to keep verification timing uniform for unknown/inactive
// usernames. A hand-typed fake like '$2a$12$000…' is 59 chars (valid hashes
// are 60), so bcryptjs short-circuits without doing the key derivation and
// the username-exists timing oracle stays open. CODE_REVIEW §3.3.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), COST);

async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length === 0) {
    throw new Error('hashPassword: a non-empty password is required');
  }
  return bcrypt.hash(plain, COST);
}

// Constant-time comparison via bcrypt. Returns false (never throws) on a
// malformed/empty hash so a corrupt user row can't crash the login path.
async function verifyPassword(plain, hash) {
  if (typeof plain !== 'string' || typeof hash !== 'string' || !hash) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword, COST, DUMMY_HASH };
