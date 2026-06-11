// Single rooted location for everything the server writes at runtime.
// Override the root with DATA_DIR (absolute, or relative to server/).
//
//   var/cache/        clearable caches — dev-cache.db (HTTP + KV/OCR).
//                     `npm run var:clean` wipes it; worst case is re-fetching
//                     and re-OCR'ing on the next run.
//   var/checkpoints/  LangGraph thread state (graph-checkpoints.db). NOT
//                     touched by var:clean — deleting it strands paused runs.
//                     Reaped by retention policy instead (checkpoints:reap).
//   var/evidence/     downloaded filing PDFs + rasterized pages, keyed by
//                     company number. Audit artifacts a reviewer's decision
//                     traces back to: never auto-deleted.
const path = require('path');
const fs = require('fs');

const SERVER_ROOT = path.join(__dirname, '..');
const DATA_ROOT = path.resolve(SERVER_ROOT, process.env.DATA_DIR || 'var');
const CACHE_DIR = path.join(DATA_ROOT, 'cache');
const CHECKPOINT_DIR = path.join(DATA_ROOT, 'checkpoints');
const EVIDENCE_ROOT = path.join(DATA_ROOT, 'evidence');

for (const dir of [CACHE_DIR, CHECKPOINT_DIR, EVIDENCE_ROOT]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { DATA_ROOT, CACHE_DIR, CHECKPOINT_DIR, EVIDENCE_ROOT };
