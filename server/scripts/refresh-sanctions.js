#!/usr/bin/env node
// Refresh local sanctions data from OFAC + UK HMT.
// Idempotent. No side effects on the agent run path.
//
// Usage:
//   npm run lists:refresh
//   npm run lists:refresh -- ofac_sdn        # one source only
require('dotenv').config();
const http = require('http');
const sanctions = require('../services/sanctions');
const { pool } = require('../db/client');

// Best-effort warning: writing ~14k sanctions rows while the dev server is
// also holding pg.Pool connections can starve the server's pool. Probing
// /api/health is cheap and only adds latency if the server is alive.
// See CODE_REVIEW §4.3.
function probeDevServer(timeoutMs = 800) {
  return new Promise((resolve) => {
    const port = Number(process.env.PORT || 3000);
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function main() {
  const arg = process.argv[2];
  if (arg && !sanctions.SOURCES.includes(arg)) {
    console.error(`unknown source '${arg}'. Known: ${sanctions.SOURCES.join(', ')}`);
    process.exit(2);
  }

  if (await probeDevServer()) {
    console.warn('');
    console.warn('  [lists:refresh] WARNING: the dev server appears to be running on this machine.');
    console.warn('  Refreshing sanctions while the server is alive contends for the pg connection');
    console.warn('  pool and can briefly stall in-flight runs. Stopping the server is recommended.');
    console.warn('  Continuing anyway in 3s — Ctrl-C to abort.');
    console.warn('');
    await new Promise((r) => setTimeout(r, 3000));
  }

  const t0 = Date.now();
  console.log(`[lists:refresh] starting${arg ? ` (source=${arg})` : ''}`);
  const results = await sanctions.refresh(arg);

  for (const r of results) {
    console.log(
      `[lists:refresh] ${r.source} v${r.version}: ${r.total} entries — ` +
        `${r.inserted} inserted, ${r.updated} updated`,
    );
  }

  const counts = await sanctions.countEntriesBySource();
  console.log('[lists:refresh] entries by source:');
  for (const c of counts) console.log(`  ${c.source}: ${c.count}`);

  console.log(`[lists:refresh] done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

main()
  .catch((err) => {
    console.error('[lists:refresh] failed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
