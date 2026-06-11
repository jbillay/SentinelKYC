const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const cache = require('./cache');

const TMP_ROOT = path.resolve(path.join(__dirname, '..', 'tmp'));

const API_BASE = 'https://api.company-information.service.gov.uk';
const DOC_BASE = 'https://document-api.company-information.service.gov.uk';

// SSRF allowlist for axios redirect-follow on document downloads. CH document
// API issues redirects to a presigned S3 URL; pin the set of acceptable hosts
// so a poisoned response can't drive an authenticated outbound request to an
// attacker-chosen host. If the S3 host changes, log the actual hostname from
// the redirect and add it here.
const ALLOWED_HOSTS = new Set([
  'api.company-information.service.gov.uk',
  'document-api.company-information.service.gov.uk',
  // Observed S3 hosts for CH document-content redirects. CH varies between
  // the virtual-host-style bucket subdomain and the bare regional endpoint
  // (path-style) depending on the document — both are legitimate, so both
  // are pinned. If CH ever changes regions this will need updating (the
  // call will throw with a clear SSRF message).
  'document-api-images-live.s3.eu-west-2.amazonaws.com',
  'document-api-images.s3.eu-west-2.amazonaws.com',
  's3.eu-west-2.amazonaws.com',
]);

// CH search lets the user type anything, but the company-number paths in this
// module must accept only the canonical CH shape (alphanumeric, 6-10 chars).
// The filesystem-write call (downloadDocumentToFile) uses the same regex.
const SAFE_COMPANY_NUMBER = /^[A-Z0-9]{6,10}$/i;
const SAFE_TRANSACTION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

const apiKey = process.env.CH_API_KEY;
if (!apiKey) {
  throw new Error('CH_API_KEY missing from .env');
}

const auth = { username: apiKey, password: '' };

// Sanitize a string that might end up in an error message bound for the
// client or fragment outputs. Strip the API key out of any URL/body that
// somehow leaked through (defence-in-depth; the key isn't supposed to be
// rendered anywhere, but a future axios change could include it via
// err.toJSON()).
function redactSecrets(message) {
  if (typeof message !== 'string' || !apiKey) return message;
  return message.split(apiKey).join('***');
}

function checkRedirectHost(options) {
  const host = options.hostname || options.host;
  if (!host || !ALLOWED_HOSTS.has(host)) {
    throw new Error(`SSRF blocked: redirect target ${host || '<unknown>'} not in allowlist`);
  }
}

async function getJson(url, { forceFresh = false } = {}) {
  if (!forceFresh) {
    const cached = cache.get(url);
    if (cached) return cached;
  }

  let res;
  try {
    res = await axios.get(url, {
      auth,
      headers: { Accept: 'application/json' },
      validateStatus: (s) => s < 500,
      maxRedirects: 5,
      beforeRedirect: checkRedirectHost,
    });
  } catch (err) {
    throw new Error(redactSecrets(`CH request failed for ${url}: ${err.message}`));
  }

  if (res.status === 404) return null;
  if (res.status >= 400) {
    throw new Error(
      redactSecrets(`CH ${res.status} for ${url}: ${JSON.stringify(res.data)}`),
    );
  }

  cache.set(url, res.data);
  return res.data;
}

function searchCompanies(query, itemsPerPage = 20, opts = {}) {
  const url = `${API_BASE}/search/companies?q=${encodeURIComponent(query)}&items_per_page=${itemsPerPage}`;
  return getJson(url, opts);
}

function getProfile(companyNumber, opts = {}) {
  if (!SAFE_COMPANY_NUMBER.test(String(companyNumber || ''))) {
    throw new Error(`invalid companyNumber: ${companyNumber}`);
  }
  return getJson(`${API_BASE}/company/${companyNumber}`, opts);
}

function getOfficers(companyNumber, opts = {}) {
  if (!SAFE_COMPANY_NUMBER.test(String(companyNumber || ''))) {
    throw new Error(`invalid companyNumber: ${companyNumber}`);
  }
  return getJson(`${API_BASE}/company/${companyNumber}/officers`, opts);
}

function getPsc(companyNumber, opts = {}) {
  if (!SAFE_COMPANY_NUMBER.test(String(companyNumber || ''))) {
    throw new Error(`invalid companyNumber: ${companyNumber}`);
  }
  return getJson(
    `${API_BASE}/company/${companyNumber}/persons-with-significant-control`,
    opts
  );
}

function getFilingHistory(companyNumber, itemsPerPage = 100, opts = {}) {
  if (!SAFE_COMPANY_NUMBER.test(String(companyNumber || ''))) {
    throw new Error(`invalid companyNumber: ${companyNumber}`);
  }
  return getJson(
    `${API_BASE}/company/${companyNumber}/filing-history?items_per_page=${itemsPerPage}`,
    opts
  );
}

function getDocumentMeta(documentId, opts = {}) {
  if (!SAFE_DOCUMENT_ID.test(String(documentId || ''))) {
    throw new Error(`invalid documentId: ${documentId}`);
  }
  return getJson(`${DOC_BASE}/document/${documentId}`, opts);
}

async function fetchDocumentBinary(documentId) {
  if (!SAFE_DOCUMENT_ID.test(String(documentId || ''))) {
    throw new Error(`invalid documentId: ${documentId}`);
  }
  const url = `${DOC_BASE}/document/${documentId}/content`;
  let res;
  try {
    res = await axios.get(url, {
      auth,
      headers: { Accept: 'application/pdf' },
      responseType: 'arraybuffer',
      maxRedirects: 5,
      beforeRedirect: checkRedirectHost,
    });
  } catch (err) {
    throw new Error(redactSecrets(`CH document fetch failed: ${err.message}`));
  }
  return Buffer.from(res.data);
}

async function getDocumentBinary(documentId) {
  return fetchDocumentBinary(documentId);
}

async function downloadDocumentToFile(documentId, companyNumber, transactionId, { forceFresh = false } = {}) {
  if (!SAFE_COMPANY_NUMBER.test(String(companyNumber || ''))) {
    throw new Error(`invalid companyNumber: ${companyNumber}`);
  }
  if (!SAFE_TRANSACTION_ID.test(String(transactionId || ''))) {
    throw new Error(`invalid transactionId: ${transactionId}`);
  }
  if (!SAFE_DOCUMENT_ID.test(String(documentId || ''))) {
    throw new Error(`invalid documentId: ${documentId}`);
  }

  const dir = path.resolve(path.join(TMP_ROOT, companyNumber));
  const filePath = path.resolve(path.join(dir, `${transactionId}.pdf`));

  // Belt-and-braces containment check in case the regex above is ever relaxed.
  if (!dir.startsWith(TMP_ROOT + path.sep) && dir !== TMP_ROOT) {
    throw new Error('path escapes TMP_ROOT');
  }
  if (!filePath.startsWith(dir + path.sep)) {
    throw new Error('path escapes company dir');
  }

  if (!forceFresh && fs.existsSync(filePath)) {
    return { path: filePath, cached: true };
  }

  await fsp.mkdir(dir, { recursive: true });
  const buf = await fetchDocumentBinary(documentId);
  await fsp.writeFile(filePath, buf);
  return { path: filePath, cached: false };
}

function documentIdFromMetadataLink(link) {
  if (!link) return null;
  const match = String(link).match(/\/document\/([^\/?#]+)/);
  const id = match ? match[1] : null;
  // Validate the captured id matches the same shape used everywhere else
  // (alphanumeric + _ + -). A malformed link should return null rather than
  // produce a doc id that breaks downstream URL construction.
  if (id && !SAFE_DOCUMENT_ID.test(id)) return null;
  return id;
}

module.exports = {
  searchCompanies,
  getProfile,
  getOfficers,
  getPsc,
  getFilingHistory,
  getDocumentMeta,
  getDocumentBinary,
  downloadDocumentToFile,
  documentIdFromMetadataLink,
  SAFE_COMPANY_NUMBER,
  SAFE_TRANSACTION_ID,
  SAFE_DOCUMENT_ID,
};
