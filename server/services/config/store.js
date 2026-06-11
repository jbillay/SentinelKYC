// Versioned agent-config persistence — the prompt-registry pattern (see
// services/prompts.js) generalized to jsonb bodies keyed by agent id.
//
// This module is deliberately dumb: no schema knowledge, no secrets handling,
// no defaults. Validation, defaults-merging, and secret encrypt/mask live in
// agents/registry.js, which is the only intended caller. Every mutation also
// writes a config_audit row (immutable change trail).

const { eq, desc, sql } = require('drizzle-orm');
const { db } = require('../../db/client');
const { agentConfigVersions, agentConfigActive, configAudit } = require('../../db/schema');

async function getActiveBody(agentId) {
  const [row] = await db
    .select({
      versionId: agentConfigVersions.id,
      version: agentConfigVersions.version,
      body: agentConfigVersions.body,
      notes: agentConfigVersions.notes,
      createdAt: agentConfigVersions.createdAt,
    })
    .from(agentConfigActive)
    .innerJoin(agentConfigVersions, eq(agentConfigVersions.id, agentConfigActive.versionId))
    .where(eq(agentConfigActive.agentId, agentId))
    .limit(1);
  return row || null;
}

async function listVersions(agentId) {
  return db
    .select({
      id: agentConfigVersions.id,
      version: agentConfigVersions.version,
      notes: agentConfigVersions.notes,
      createdBy: agentConfigVersions.createdBy,
      createdAt: agentConfigVersions.createdAt,
    })
    .from(agentConfigVersions)
    .where(eq(agentConfigVersions.agentId, agentId))
    .orderBy(desc(agentConfigVersions.version));
}

async function getVersion(versionId) {
  const [row] = await db
    .select()
    .from(agentConfigVersions)
    .where(eq(agentConfigVersions.id, versionId))
    .limit(1);
  return row || null;
}

async function writeAudit({ scope, action, versionId = null, actor = null, details = null }) {
  await db.insert(configAudit).values({ scope, action, versionId, actor, details });
}

// Creates a new version AND activates it in one step (agent config is
// operational tuning, not A/B-tested content — the two-step create/activate
// flow the prompt registry uses buys nothing here). Both steps are audited.
async function createAndActivate(agentId, body, { notes = null, actor = null } = {}) {
  const result = await db.execute(
    sql`select coalesce(max(version), 0) + 1 as next from agent_config_versions where agent_id = ${agentId}`
  );
  const nextVersion = Number(result.rows?.[0]?.next ?? 1);

  const [row] = await db
    .insert(agentConfigVersions)
    .values({ agentId, version: nextVersion, body, notes, createdBy: actor })
    .returning();

  await db
    .insert(agentConfigActive)
    .values({ agentId, versionId: row.id })
    .onConflictDoUpdate({
      target: agentConfigActive.agentId,
      set: { versionId: row.id, updatedAt: sql`now()` },
    });

  await writeAudit({
    scope: `agent:${agentId}`,
    action: 'create_and_activate',
    versionId: row.id,
    actor,
    details: { version: nextVersion, notes },
  });

  return row;
}

async function listAudit({ scope = null, limit = 200 } = {}) {
  const q = db.select().from(configAudit).orderBy(desc(configAudit.createdAt)).limit(limit);
  if (scope) return q.where(eq(configAudit.scope, scope));
  return q;
}

module.exports = {
  getActiveBody,
  listVersions,
  getVersion,
  createAndActivate,
  writeAudit,
  listAudit,
};
