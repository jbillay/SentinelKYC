// Idempotent seed for the risk matrix registry. Mirrors prompts.seedPrompts():
// inserts the bundled default matrix as v1 and points the singleton-active row
// at it — but only when the registry has not been initialised yet.

const { eq, asc } = require('drizzle-orm');
const { db } = require('../../db/client');
const { riskMatrixVersions, riskMatrixActive } = require('../../db/schema');
const { defaultMatrixBody, assertValidMatrix, invalidate } = require('./matrix');

async function seedRiskMatrix() {
  const [active] = await db
    .select({ versionId: riskMatrixActive.versionId })
    .from(riskMatrixActive)
    .where(eq(riskMatrixActive.id, 1))
    .limit(1);
  if (active) return; // already initialised — never overwrite a chosen active version

  const body = defaultMatrixBody();
  assertValidMatrix(body); // fail loudly if our own default is malformed

  // Reuse an existing v1 if a prior partial run created the version without the
  // active pointer; otherwise insert it.
  let [v1] = await db
    .select({ id: riskMatrixVersions.id })
    .from(riskMatrixVersions)
    .orderBy(asc(riskMatrixVersions.version))
    .limit(1);
  if (!v1) {
    [v1] = await db
      .insert(riskMatrixVersions)
      .values({ version: 1, body, notes: body.notes || 'v1 — seeded default' })
      .returning({ id: riskMatrixVersions.id });
  }

  await db.insert(riskMatrixActive).values({ id: 1, versionId: v1.id });
  invalidate();
}

module.exports = { seedRiskMatrix };
