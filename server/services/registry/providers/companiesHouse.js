// Companies House — the BASE registry data provider. Free, always present;
// its response shapes are the canonical wire format of the registry port
// (enrichment vendors adapt TO these shapes, not the other way round).
//
// All the operational hardening (HTTP cache, SSRF allowlist on document
// redirects, input-validation regexes, secret redaction) lives in
// services/ch.js — this adapter only maps the client onto the capability
// interface.

const ch = require('../../ch');

module.exports = {
  id: 'companies_house',
  name: 'Companies House (UK)',
  role: 'base',
  capabilities: {
    search: true,
    profile: true,
    officers: true,
    ownership: true, // PSC register
    filings: true,
    documents: true, // filing PDFs via the Document API
  },

  search: (query, itemsPerPage, opts) => ch.searchCompanies(query, itemsPerPage, opts),
  getProfile: (companyNumber, opts) => ch.getProfile(companyNumber, opts),
  getOfficers: (companyNumber, opts) => ch.getOfficers(companyNumber, opts),
  getOwnership: (companyNumber, opts) => ch.getPsc(companyNumber, opts),
  getFilings: (companyNumber, itemsPerPage, opts) => ch.getFilingHistory(companyNumber, itemsPerPage, opts),

  getDocumentMeta: (documentId, opts) => ch.getDocumentMeta(documentId, opts),
  getDocumentBinary: (documentId) => ch.getDocumentBinary(documentId),
  downloadDocumentToFile: (documentId, companyNumber, transactionId, opts) =>
    ch.downloadDocumentToFile(documentId, companyNumber, transactionId, opts),
  documentIdFromMetadataLink: (link) => ch.documentIdFromMetadataLink(link),
};
