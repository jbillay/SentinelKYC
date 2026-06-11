#!/usr/bin/env node
// One-shot cleanup of cached CH PDFs / rasterized pages under server/tmp.
//
// Usage:
//   npm run tmp:clean                # delete files older than the default
//   npm run tmp:clean -- --days 7    # custom age threshold
//   npm run tmp:clean -- --all       # remove every cached file
//
// Also called from index.js#start so a long-running dev session doesn't grow
// server/tmp without bound. See CODE_REVIEW §4.5.
const path = require('path');
const fsp = require('fs/promises');

const TMP_ROOT = path.resolve(path.join(__dirname, '..', 'tmp'));
const DEFAULT_MAX_AGE_DAYS = 30;

function parseArgs(argv) {
  const out = { days: DEFAULT_MAX_AGE_DAYS, all: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') out.all = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a === '--days') {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n >= 0) out.days = n;
    }
  }
  return out;
}

async function cleanDir(dir, cutoffMs, { quiet }) {
  let removedFiles = 0;
  let removedBytes = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return { removedFiles, removedBytes };
    throw err;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = await cleanDir(full, cutoffMs, { quiet });
      removedFiles += sub.removedFiles;
      removedBytes += sub.removedBytes;
      // Best-effort empty-dir cleanup.
      try {
        const remaining = await fsp.readdir(full);
        if (remaining.length === 0) await fsp.rmdir(full);
      } catch {
        // noop
      }
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const stat = await fsp.stat(full);
      if (stat.mtimeMs < cutoffMs) {
        await fsp.unlink(full);
        removedFiles += 1;
        removedBytes += stat.size;
      }
    } catch (err) {
      if (!quiet) console.warn(`[tmp-clean] could not handle ${full}: ${err.message}`);
    }
  }
  return { removedFiles, removedBytes };
}

async function cleanTmp({ days = DEFAULT_MAX_AGE_DAYS, all = false, quiet = false } = {}) {
  const cutoffMs = all ? Date.now() + 1 : Date.now() - days * 24 * 60 * 60 * 1000;
  return cleanDir(TMP_ROOT, cutoffMs, { quiet });
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  cleanTmp(args)
    .then(({ removedFiles, removedBytes }) => {
      const mb = (removedBytes / (1024 * 1024)).toFixed(2);
      console.log(`[tmp-clean] removed ${removedFiles} file(s), ${mb} MB${args.all ? ' (--all)' : ` older than ${args.days} day(s)`}`);
    })
    .catch((err) => {
      console.error('[tmp-clean] failed:', err);
      process.exitCode = 1;
    });
}

module.exports = { cleanTmp, TMP_ROOT, DEFAULT_MAX_AGE_DAYS };
