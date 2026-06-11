// Adverse media provider. Hides the underlying provider (GDELT 2.0 DOC API)
// and enforces cache-through. Two cache layers, both with ISO-week TTL:
//   1. party-keyed (G1) — sha256(party:<id>|isoWeek|max), cross-dossier: the
//      resolver gives the same human one partyId everywhere, so a shared
//      individual costs one GDELT fetch per week across all dossiers.
//   2. name-keyed (legacy) — sha256(name|isoWeek|max); covers legacy subjects
//      with no partyId and cross-party same-name reuse.
// Lookup: party → name → GDELT. A real fetch writes BOTH caches.

const cache = require('./cache');
const { searchGdelt } = require('./gdelt');

async function search(name, opts = {}) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    return { articles: [], cacheHit: false };
  }
  const max = opts.max || 20;
  const partyId = opts.partyId || null;

  if (partyId) {
    const byParty = cache.getByParty(partyId, { max });
    if (byParty) {
      return { articles: byParty, cacheHit: true, cacheLayer: 'party' };
    }
  }
  const cached = cache.get(name, { max });
  if (cached) {
    // Promote into the party cache so next week's alias spellings hit too.
    if (partyId) cache.setByParty(partyId, { max }, cached);
    return { articles: cached, cacheHit: true, cacheLayer: 'name' };
  }
  const articles = await searchGdelt(name, { count: max });
  cache.set(name, { max }, articles);
  if (partyId) cache.setByParty(partyId, { max }, articles);
  return { articles, cacheHit: false };
}

module.exports = { search };
