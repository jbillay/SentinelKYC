const path = require('path');
const Database = require('better-sqlite3');
const metrics = require('./metrics');
const { CACHE_DIR } = require('../lib/dataDirs');

const dbPath = path.join(CACHE_DIR, 'dev-cache.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS http_cache (
    url TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv_cache (
    namespace TEXT NOT NULL,
    key TEXT NOT NULL,
    body TEXT NOT NULL,
    stored_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, key)
  );
`);

const getStmt = db.prepare('SELECT body FROM http_cache WHERE url = ?');
const setStmt = db.prepare(
  'INSERT OR REPLACE INTO http_cache (url, body, fetched_at) VALUES (?, ?, ?)'
);

const kvGetStmt = db.prepare(
  'SELECT body FROM kv_cache WHERE namespace = ? AND key = ?'
);
const kvSetStmt = db.prepare(
  'INSERT OR REPLACE INTO kv_cache (namespace, key, body, stored_at) VALUES (?, ?, ?, ?)'
);

function get(url) {
  const row = getStmt.get(url);
  metrics.inc(row ? 'cache_hit_total' : 'cache_miss_total', { cache: 'http_cache' });
  if (!row) return null;
  try {
    return JSON.parse(row.body);
  } catch {
    return null;
  }
}

function set(url, data) {
  setStmt.run(url, JSON.stringify(data), Date.now());
}

function kvGet(namespace, key) {
  const row = kvGetStmt.get(namespace, key);
  metrics.inc(row ? 'cache_hit_total' : 'cache_miss_total', { cache: 'kv_cache' });
  if (!row) return null;
  try {
    return JSON.parse(row.body);
  } catch {
    return null;
  }
}

function kvSet(namespace, key, data) {
  kvSetStmt.run(namespace, key, JSON.stringify(data), Date.now());
}

module.exports = { get, set, kvGet, kvSet };
