#!/usr/bin/env node
// One-shot wipe of the clearable cache tree (var/cache — dev-cache.db, the
// HTTP + KV/OCR caches). Worst case after a wipe is re-fetching from CH and
// re-OCR'ing on the next run.
//
// Deliberately does NOT touch:
//   var/checkpoints — LangGraph thread state; deleting it strands paused runs
//                     (reaped by retention policy via checkpoints:reap)
//   var/evidence    — downloaded filing PDFs + rasterized pages; audit
//                     artifacts, never auto-deleted
//
// Run with the server stopped — the cache db is held open by a running app.
//
// Usage: npm run var:clean
const path = require('path');
const fsp = require('fs/promises');

const { CACHE_DIR } = require('../lib/dataDirs');

async function cleanCache() {
  let removedFiles = 0;
  let removedBytes = 0;
  let entries;
  try {
    entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removedFiles, removedBytes };
    throw err;
  }

  for (const entry of entries) {
    const full = path.join(CACHE_DIR, entry.name);
    try {
      if (entry.isFile()) {
        const stat = await fsp.stat(full);
        removedBytes += stat.size;
        removedFiles += 1;
      }
      await fsp.rm(full, { recursive: true, force: true });
    } catch (err) {
      console.warn(`[var-clean] could not remove ${full}: ${err.message}`);
    }
  }
  return { removedFiles, removedBytes };
}

if (require.main === module) {
  cleanCache()
    .then(({ removedFiles, removedBytes }) => {
      const mb = (removedBytes / (1024 * 1024)).toFixed(2);
      console.log(`[var-clean] cleared var/cache — ${removedFiles} file(s), ${mb} MB`);
    })
    .catch((err) => {
      console.error('[var-clean] failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { cleanCache };
