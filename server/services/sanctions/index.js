const ofac = require('./sources/ofac');
const ukHmt = require('./sources/uk_hmt');
const store = require('./store');
const matcher = require('./matcher');
const { normalizeName } = require('./normalize');

const SOURCES = {
  [ofac.SOURCE_ID]: ofac,
  [ukHmt.SOURCE_ID]: ukHmt,
};

// Refresh sanctions data from one or all sources. Returns per-source counts.
async function refresh(sourceId) {
  const ids = sourceId ? [sourceId] : Object.keys(SOURCES);
  const results = [];
  for (const id of ids) {
    const src = SOURCES[id];
    if (!src) throw new Error(`sanctions.refresh: unknown source ${id}`);
    const it = src.fetchEntries();
    const first = await it.next();
    if (first.done || !first.value || !first.value.__meta) {
      throw new Error(`sanctions.refresh: source ${id} did not yield meta`);
    }
    const meta = first.value.__meta;

    const entries = [];
    for await (const entry of it) entries.push(entry);

    const counts = await store.upsertEntries(id, entries);
    await store.insertListVersion({
      source: meta.source,
      version: meta.version,
      fetchedAt: meta.fetchedAt,
      recordCount: entries.length,
    });
    results.push({ source: id, version: meta.version, ...counts, total: entries.length });
  }
  return results;
}

// Search across all sanctions sources. Pre-filter by first normalized token,
// then run the fuzzy matcher.
async function search(name, { threshold = 0.85, source } = {}) {
  const normalized = normalizeName(name);
  if (!normalized) return [];
  const candidates = await store.searchByNormalizedName(normalized, { source });
  return matcher.matchSubject({ name, normalizedName: normalized }, candidates, threshold);
}

module.exports = {
  refresh,
  search,
  getEntry: store.getEntry,
  listVersions: store.listVersions,
  countEntriesBySource: store.countEntriesBySource,
  SOURCES: Object.keys(SOURCES),
};
