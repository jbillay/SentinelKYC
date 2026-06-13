// db/repo/users.js — application user store (R1 auth).
// Split from the monolithic db/repo.js (CODE_REVIEW §6.5). db/repo.js is the
// re-exporting facade — call sites keep requiring '../db/repo'.
/* eslint-disable no-unused-vars */
const { eq, desc, asc, and, sql, ilike, inArray, notInArray } = require('drizzle-orm');
const { db } = require('../client');
const {
  dossiers,
  runs,
  runEvents,
  decisionFragments,
  screeningHits,
  screeningEvaluations,
  dossierScreeningOverrides,
  screeningConfig,
  sanctionsLists,
  sanctionsEntries,
  riskMatrixVersions,
  riskMatrixActive,
  parties,
  partyMatchLog,
  partyLinks,
  partyLinkStatusHistory,
  partyReviewQueue,
  partyScreeningOverrides,
  partyWatchlist,
  users,
} = require('../schema');
/* eslint-enable no-unused-vars */

async function getUserByUsername(username) {
  if (!username) return null;
  const [row] = await db
    .select()
    .from(users)
    .where(eq(sql`lower(${users.username})`, String(username).toLowerCase()))
    .limit(1);
  return row || null;
}

async function getUserById(id) {
  if (!id) return null;
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return row || null;
}

// Admin Members list — safe fields only (never password_hash). Ordered by
// username for a stable display. Read path for GET /api/admin/users.
async function listUsers() {
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      active: users.active,
      createdAt: users.createdAt,
      lastLoginAt: users.lastLoginAt,
    })
    .from(users)
    .orderBy(asc(users.username));
}

// Idempotent insert used by the seed script: insert, or update the password /
// role / active fields on conflict so re-seeding rotates credentials cleanly.

async function upsertUser({ username, displayName, passwordHash, role = 'analyst', active = true }) {
  if (!username) throw new Error('upsertUser: username required');
  if (!passwordHash) throw new Error('upsertUser: passwordHash required');
  const [row] = await db
    .insert(users)
    .values({
      username,
      displayName: displayName ?? null,
      passwordHash,
      role,
      active,
    })
    .onConflictDoUpdate({
      target: users.username,
      set: {
        displayName: displayName ?? null,
        passwordHash,
        role,
        active,
      },
    })
    .returning();
  return row;
}

async function touchUserLogin(id) {
  if (!id) return;
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, id));
}

// Self-service profile update. Only the keys present in `patch` are written
// (displayName / username / email). Uniqueness (username, email) is enforced by
// the DB indexes; a violation surfaces as a pg error code 23505 which the route
// maps to a 409. Returns the updated row.

async function updateUserProfile(id, patch = {}) {
  if (!id) throw new Error('updateUserProfile: id required');
  const set = {};
  if (patch.displayName !== undefined) set.displayName = patch.displayName;
  if (patch.username !== undefined) set.username = patch.username;
  if (patch.email !== undefined) set.email = patch.email;
  if (Object.keys(set).length === 0) return getUserById(id);
  const [row] = await db.update(users).set(set).where(eq(users.id, id)).returning();
  return row || null;
}

async function updateUserPassword(id, passwordHash) {
  if (!id) throw new Error('updateUserPassword: id required');
  if (!passwordHash) throw new Error('updateUserPassword: passwordHash required');
  const [row] = await db
    .update(users)
    .set({ passwordHash })
    .where(eq(users.id, id))
    .returning();
  return row || null;
}

module.exports = {
  getUserByUsername,
  getUserById,
  listUsers,
  upsertUser,
  touchUserLogin,
  updateUserProfile,
  updateUserPassword,
};
