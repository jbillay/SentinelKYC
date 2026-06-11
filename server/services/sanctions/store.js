const { eq, and, sql, like } = require('drizzle-orm');
const { db } = require('../../db/client');
const { sanctionsLists, sanctionsEntries } = require('../../db/schema');
const { firstToken, normalizeName } = require('./normalize');

async function insertListVersion({ source, version, fetchedAt, recordCount }) {
  const [row] = await db
    .insert(sanctionsLists)
    .values({ source, version, fetchedAt, recordCount })
    .onConflictDoUpdate({
      target: [sanctionsLists.source, sanctionsLists.version],
      set: { fetchedAt, recordCount },
    })
    .returning();
  return row;
}

// Bulk-upsert entries for a single source. Returns counts.
async function upsertEntries(source, entries) {
  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  if (!entries.length) return { inserted, updated, unchanged };

  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK).map((e) => ({
      listSource: source,
      listEntryId: e.list_entry_id,
      entryType: e.entry_type,
      primaryName: e.primary_name,
      normalizedName: e.normalized_name || normalizeName(e.primary_name),
      aliases: e.aliases || [],
      dob: e.dob || null,
      nationality: e.nationality || null,
      identifiers: e.identifiers || null,
      programs: e.programs || null,
      raw: e.raw || {},
    }));

    const result = await db
      .insert(sanctionsEntries)
      .values(chunk)
      .onConflictDoUpdate({
        target: [sanctionsEntries.listSource, sanctionsEntries.listEntryId],
        set: {
          entryType: sql`excluded.entry_type`,
          primaryName: sql`excluded.primary_name`,
          normalizedName: sql`excluded.normalized_name`,
          aliases: sql`excluded.aliases`,
          dob: sql`excluded.dob`,
          nationality: sql`excluded.nationality`,
          identifiers: sql`excluded.identifiers`,
          programs: sql`excluded.programs`,
          raw: sql`excluded.raw`,
        },
      })
      .returning({ id: sanctionsEntries.id, createdAt: sanctionsEntries.createdAt });

    // RETURNING gives us the row regardless of insert-vs-update; we don't
    // currently distinguish those cleanly through onConflictDoUpdate. The
    // counts below are a useful approximation: a row whose createdAt is
    // within the last 5s is "inserted", otherwise "updated".
    const cutoff = Date.now() - 5_000;
    for (const r of result) {
      if (new Date(r.createdAt).getTime() >= cutoff) inserted += 1;
      else updated += 1;
    }
  }

  // unchanged not separately tracked in this POC.
  return { inserted, updated, unchanged };
}

async function listVersions() {
  return db
    .select({
      source: sanctionsLists.source,
      version: sanctionsLists.version,
      fetchedAt: sanctionsLists.fetchedAt,
      recordCount: sanctionsLists.recordCount,
    })
    .from(sanctionsLists)
    .orderBy(sanctionsLists.fetchedAt);
}

async function countEntriesBySource() {
  const rows = await db
    .select({
      source: sanctionsEntries.listSource,
      count: sql`count(*)::int`,
    })
    .from(sanctionsEntries)
    .groupBy(sanctionsEntries.listSource);
  return rows;
}

async function getEntry(id) {
  const [row] = await db
    .select()
    .from(sanctionsEntries)
    .where(eq(sanctionsEntries.id, id))
    .limit(1);
  return row || null;
}

// Pre-filter candidate entries by first normalized token + (optional) source.
// Used by the matcher: shrinks the candidate set from ~14k to a few dozen
// before paying the Levenshtein cost.
//
// Previous cap of 500 dropped legitimate candidates for common surnames on
// OFAC SDN. The full sanctions corpus is in the tens of thousands of entries;
// 5000 is practically unlimited for v1 but still acts as a brake on a
// runaway query. See CODE_REVIEW §4.4.
async function searchByNormalizedName(normalized, { source, limit = 5000 } = {}) {
  const tok = firstToken(normalized);
  if (!tok) return [];
  const conds = [like(sanctionsEntries.normalizedName, `${tok}%`)];
  if (source) conds.push(eq(sanctionsEntries.listSource, source));
  return db
    .select()
    .from(sanctionsEntries)
    .where(and(...conds))
    .limit(limit);
}

module.exports = {
  insertListVersion,
  upsertEntries,
  listVersions,
  countEntriesBySource,
  getEntry,
  searchByNormalizedName,
};
