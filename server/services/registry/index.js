// Phase 3 — the registry data port. Capability-keyed composition over
// pluggable vendors: Companies House is the always-on BASE provider (free,
// canonical shapes); enrichment vendors layer on top per capability, filling
// gaps and adding fields with per-field attribution (`_vendorAttribution`).
//
// Which enrichers run comes from the entity-resolution agent config
// (`enrichmentVendors`, Settings → Agents) — UI-driven, versioned, audited.
// A vendor that lacks a capability is simply inert for it: CH is the only
// document-capable provider, so the document manager keeps working
// unchanged whatever enrichment is configured.
//
// Adding a real vendor (Orbis-class) = one file under providers/ exposing
// { id, role:'enrich', capabilities, enrich<Capability>() } + its id in the
// agent-config enum. Credentials would be secret-flagged agent-config
// fields (encrypted at rest — plumbing already live in agents/config.js).

const companiesHouse = require('./providers/companiesHouse');
const mock = require('./providers/mock');
const { composeRecord } = require('./merge');

const BASE = companiesHouse;
const ENRICHERS = { [mock.id]: mock };

async function configuredEnrichers() {
  // Lazy require: keeps this module importable without a DB (pure tests use
  // composeRecord/providers directly).
  const { loadAgentConfig } = require('../../agents/config');
  let ids = [];
  try {
    ids = (await loadAgentConfig('entity-resolution')).enrichmentVendors || [];
  } catch {
    ids = []; // config unavailable (standalone script) → base-only
  }
  return ids.map((id) => ENRICHERS[id]).filter(Boolean);
}

async function runEnrichment(capability, method, args, base) {
  if (base == null) return base;
  const enrichers = await configuredEnrichers();
  const results = [];
  for (const vendor of enrichers) {
    if (!vendor.capabilities?.[capability] || typeof vendor[method] !== 'function') continue;
    try {
      results.push({ vendorId: vendor.id, data: await vendor[method](...args, base) });
    } catch {
      // Enrichment is best-effort by contract: a vendor outage must never
      // fail the base fetch. (The base provider's errors DO propagate.)
      results.push({ vendorId: vendor.id, data: null });
    }
  }
  return composeRecord(base, results);
}

// --- capabilities ----------------------------------------------------------

async function search(query, itemsPerPage = 20, opts = {}) {
  return BASE.search(query, itemsPerPage, opts);
}

async function getProfile(companyNumber, opts = {}) {
  const base = await BASE.getProfile(companyNumber, opts);
  return runEnrichment('profile', 'enrichProfile', [companyNumber], base);
}

async function getOfficers(companyNumber, opts = {}) {
  const base = await BASE.getOfficers(companyNumber, opts);
  return runEnrichment('officers', 'enrichOfficers', [companyNumber], base);
}

async function getOwnership(companyNumber, opts = {}) {
  const base = await BASE.getOwnership(companyNumber, opts);
  return runEnrichment('ownership', 'enrichOwnership', [companyNumber], base);
}

async function getFilings(companyNumber, itemsPerPage = 100, opts = {}) {
  return BASE.getFilings(companyNumber, itemsPerPage, opts);
}

// Documents: CH is the only document-capable provider — passthrough, all the
// hardening stays in services/ch.js.
const getDocumentMeta = BASE.getDocumentMeta;
const getDocumentBinary = BASE.getDocumentBinary;
const downloadDocumentToFile = BASE.downloadDocumentToFile;
const documentIdFromMetadataLink = BASE.documentIdFromMetadataLink;

function listProviders() {
  return [BASE, ...Object.values(ENRICHERS)].map((p) => ({
    id: p.id,
    name: p.name,
    role: p.role,
    capabilities: p.capabilities,
  }));
}

module.exports = {
  search,
  getProfile,
  getOfficers,
  getOwnership,
  getFilings,
  getDocumentMeta,
  getDocumentBinary,
  downloadDocumentToFile,
  documentIdFromMetadataLink,
  listProviders,
  // exported for tests
  _internals: { runEnrichment, configuredEnrichers, ENRICHERS, BASE },
};
