// CODE_REVIEW §5.1 — LangGraph checkpoint reaper.
//
// graph-checkpoints.db grows without bound: every step of every thread writes
// full-state checkpoint rows (OCR text, profile/officers/PSC blobs, screening
// hits) and threads are one-shot UUIDs, so finished threads are pure dead
// weight. This reaper deletes the SQLite checkpoint rows for threads whose run
// reached a terminal status more than CHECKPOINT_RETENTION_DAYS ago.
//
// Safety rules:
//   * Runs still 'running' (incl. paused at a human interrupt) are NEVER
//     touched — resume needs their checkpoint.
//   * Threads with no run row at all (never-confirmed searches, or threads
//     whose runs were deleted from Postgres) are skipped by default — we
//     cannot reliably age them and one COULD be an in-flight pre-persist run.
//     The CLI's --orphans flag deletes them too: safe to use when no run is
//     executing (they are the bulk of the file after a DB reset).
//   * resume-failed only consumes checkpoints younger than the retention
//     window, so the default of 7 days keeps that path intact.
//
// Used two ways: `npm run checkpoints:reap` (CLI, with VACUUM) and from
// index.js#start at boot (module call, best-effort, VACUUM only when enough
// rows were removed to be worth the pause).
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_RETENTION_DAYS = Number(process.env.CHECKPOINT_RETENTION_DAYS || 7);
const CHECKPOINT_DB = path.join(__dirname, '..', 'graph-checkpoints.db');

const TERMINAL_STATUSES = new Set(['done', 'failed', 'not_found', 'cancelled']);

async function reapCheckpoints({
  retentionDays = DEFAULT_RETENTION_DAYS,
  vacuum = false,
  quiet = false,
  // Also delete threads with NO run row. CLI-only (--orphans); never set on
  // the boot path — a worker could be driving a not-yet-persisted run.
  includeOrphans = false,
} = {}) {
  // Lazy requires so importing this module costs nothing when the feature is
  // unused and so the CLI can control pool lifetime.
  const Database = require('better-sqlite3');
  const { pool } = require('../db/client');

  const fs = require('fs');
  if (!fs.existsSync(CHECKPOINT_DB)) {
    return { threadsSeen: 0, threadsReaped: 0, rowsDeleted: 0 };
  }

  const sqlite = new Database(CHECKPOINT_DB);
  try {
    const threadIds = sqlite
      .prepare('SELECT DISTINCT thread_id FROM checkpoints')
      .all()
      .map((r) => r.thread_id);
    if (threadIds.length === 0) {
      return { threadsSeen: 0, threadsReaped: 0, rowsDeleted: 0 };
    }

    // One round-trip: every run row for these threads. Eligible = terminal
    // and older than the retention window; with includeOrphans, also any
    // thread that has no run row at all.
    const { rows } = await pool.query(
      `SELECT thread_id, status, ended_at FROM runs WHERE thread_id = ANY($1)`,
      [threadIds],
    );
    const byThread = new Map(rows.map((r) => [r.thread_id, r]));
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const eligible = threadIds.filter((id) => {
      const run = byThread.get(id);
      if (!run) return includeOrphans;
      return (
        TERMINAL_STATUSES.has(run.status) &&
        run.ended_at &&
        new Date(run.ended_at).getTime() < cutoff
      );
    });

    if (eligible.length === 0) {
      return { threadsSeen: threadIds.length, threadsReaped: 0, rowsDeleted: 0 };
    }

    const delWrites = sqlite.prepare('DELETE FROM writes WHERE thread_id = ?');
    const delCheckpoints = sqlite.prepare('DELETE FROM checkpoints WHERE thread_id = ?');
    let rowsDeleted = 0;
    const reapAll = sqlite.transaction((ids) => {
      for (const id of ids) {
        rowsDeleted += delWrites.run(id).changes;
        rowsDeleted += delCheckpoints.run(id).changes;
      }
    });
    reapAll(eligible);

    if (vacuum && rowsDeleted > 0) {
      sqlite.exec('VACUUM');
    }

    if (!quiet) {
      console.log(
        `[checkpoints] reaped ${eligible.length}/${threadIds.length} thread(s), ${rowsDeleted} row(s)` +
          (vacuum && rowsDeleted > 0 ? ', vacuumed' : ''),
      );
    }
    return { threadsSeen: threadIds.length, threadsReaped: eligible.length, rowsDeleted };
  } finally {
    sqlite.close();
  }
}

module.exports = { reapCheckpoints, DEFAULT_RETENTION_DAYS };

if (require.main === module) {
  const includeOrphans = process.argv.includes('--orphans');
  reapCheckpoints({ vacuum: true, includeOrphans })
    .then(async (out) => {
      const { pool } = require('../db/client');
      await pool.end();
      console.log(`[checkpoints] done: ${JSON.stringify(out)}`);
    })
    .catch((err) => {
      console.error('[checkpoints] reap failed:', err.message);
      process.exit(1);
    });
}
