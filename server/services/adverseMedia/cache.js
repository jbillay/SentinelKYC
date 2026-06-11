const crypto = require('crypto');
const { kvGet, kvSet } = require('../cache');

const NAMESPACE = 'adverse_media';

function isoWeek(date = new Date()) {
  // ISO week-numbering year + week. Monday-based; weeks 01..53.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function buildKey(name, opts = {}) {
  const week = opts.isoWeek || isoWeek();
  const max = opts.max || 20;
  const raw = `${name.trim().toLowerCase()}|${week}|${max}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// G1 — party-keyed cache layer. The party master gives the same human one id
// across dossiers, so John Smith screened on three dossiers costs ONE GDELT
// fetch per ISO week instead of three (the name-keyed cache already dedupes
// identical surface forms; the party key also catches alias spellings that
// resolve to the same party). Same ISO-week TTL semantics — a watchlisted
// party still re-fetches weekly.
function buildPartyKey(partyId, opts = {}) {
  const week = opts.isoWeek || isoWeek();
  const max = opts.max || 20;
  const raw = `party:${partyId}|${week}|${max}`;
  return crypto.createHash('sha256').update(raw).digest('hex');
}

function get(name, opts) {
  const key = buildKey(name, opts);
  return kvGet(NAMESPACE, key);
}

function set(name, opts, value) {
  const key = buildKey(name, opts);
  kvSet(NAMESPACE, key, value);
}

function getByParty(partyId, opts) {
  return kvGet(NAMESPACE, buildPartyKey(partyId, opts));
}

function setByParty(partyId, opts, value) {
  kvSet(NAMESPACE, buildPartyKey(partyId, opts), value);
}

module.exports = { get, set, getByParty, setByParty, buildKey, buildPartyKey, isoWeek, NAMESPACE };
