// Mock enrichment vendor — fixture-backed, deterministic, no network. Two
// jobs: (1) prove the composition seam end to end (the Orbis/BvD slot) so a
// real vendor adapter is a drop-in; (2) give CI and demos an enrichment
// path that exercises merge + attribution without credentials.
//
// Disabled by default; enable via Settings → Agents → Entity resolution →
// enrichment vendors. Shapes follow the CH wire format (the port contract).

const FIXTURES = {
  // Keyed by company number; '*' applies to any company.
  '*': {
    profile: {
      // Gap-fill: only lands when CH did not supply sic_codes (rare).
      sic_codes: ['64999'],
      // Additive block: a clearly-labelled demo enrichment a real vendor
      // would replace with curated data (industry view, group linkage, …).
      vendor_enrichment: {
        provider: 'mock',
        industry_view: 'Financial services (demo enrichment)',
        data_quality_score: 0.92,
        last_verified: '2026-01-01',
      },
    },
  },
};

module.exports = {
  id: 'mock',
  name: 'Mock vendor (demo enrichment)',
  role: 'enrich',
  capabilities: {
    profile: true,
  },

  // Enrichers receive the merged-so-far record and return a partial in the
  // same shape (or null for "nothing to add"). They must never mutate it.
  async enrichProfile(companyNumber, _currentProfile, _opts = {}) {
    const fixture = FIXTURES[companyNumber] || FIXTURES['*'];
    return fixture?.profile ?? null;
  },
};
