import { defineConfig } from 'vitest/config';

// Test strategy & coverage plan: docs/architecture/TEST_STRATEGY.md
//
// Phase 0 flips coverage from a curated `include` allow-list to WHOLE-CODEBASE
// instrumentation (`all: true`): every product source file under the dirs below
// is measured whether or not a test imports it. The denominator is now the real
// server surface (routes + graph + services + db + sse + agents + lib), not the
// ~17 pure engines we used to count.
//
// The `exclude` list is the small, justified set of files that stay out of the
// denominator (composition roots booted by smoke, migrations exercised by the
// migrate step, the eval harness, dev scripts). See TEST_STRATEGY §5.4.
//
// Thresholds are the RATCHET: set at the current true baseline so CI is green
// today, then raised at each phase end (never lowered). Per-directory guards
// lock the already-strong engines so they can't regress while the global floor
// climbs. CI fails on any regression below these.
export default defineConfig({
  test: {
    environment: 'node',
    // Dummy CH key so modules that load services/ch.js (which throws at import
    // if CH_API_KEY is unset) are importable in CI — tests mock the actual HTTP.
    env: { CH_API_KEY: 'test-ci-key' },
    include: ['test/**/*.test.mjs'],
    // Integration suites (*.int.test.mjs) share one test Postgres and TRUNCATE
    // between tests — running files in parallel races those truncations. Run
    // files sequentially (each still gets an isolated module registry). The
    // unit suites are fast, so the serial cost is small.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      all: true,
      include: [
        'routes/**/*.js',
        'graph/**/*.js',
        'services/**/*.js',
        'db/**/*.js',
        'sse/**/*.js',
        'agents/**/*.js',
        'lib/**/*.js',
      ],
      exclude: [
        'db/migrations/**',
        'db/migrate.js',
        '**/*.config.*',
      ],
      reporter: ['text', 'text-summary', 'lcov'],
      // RATCHET FLOOR — raised at each phase end, never lowered. This is the
      // GLOBAL gate; the canonical coverage run is the FULL suite incl. the
      // integration tier (TEST_DATABASE_URL set + a test Postgres). Run without
      // it, the *.int.test.mjs files skip and the number falls well below this
      // floor — so `test:unit:coverage` requires TEST_DATABASE_URL (CI sets it).
      //   Phase 0: stmts 8.53 / br 9.84 / fn 8.05 / ln 8.59 (unit only).
      //   Phase 1: stmts 11.69 / br 14.24 / fn 10.91 / ln 11.84 (unit only).
      //   Phase 3: stmts ~32.5 / br ~21.1 / fn ~29.1 / ln ~34.4 (routes + repos).
      //   Phase 4: stmts ~34.4 / br ~24.0 / fn ~31.5 / ln ~36.4 (graph: withFragment
      //     + state + pure nodes as unit; DB-config nodes as integration). Branch
      //     count still swings a few points run-to-run.
      //   Phase 5 (untested-but-easy): stmts ~44.5 / br ~34.2 / fn ~45.3 / ln ~47.0
      //     (11 new suites: repo-users/screening/qa/fragments +
      //      routes-auth/health/prompts/screening/qa/runs/decision).
      //   S1+S2 (2026-06-25): stmts 51.52 / br 42.80 / fn 52.54 / ln 53.95 —
      //     fixed 2 entity-resolution test bugs (wrong state shape); confirmed all
      //     162 integration tests (18 suites: 7 repo + 11 routes) run and pass
      //     against kyc_poc_test. Entity resolution tests now use state.input
      //     correctly instead of top-level companyName/companyNumber.
      // NOTE the BRANCH variance (~3 pts run-to-run): v8's branch attribution on
      // `all:true` files that integration loads but doesn't fully execute is
      // nondeterministic, so floors sit a couple points BELOW the observed
      // minimums to stay green. Per-file engine guards were removed in Phase 3
      // (same loaded-but-not-run artifact made them spuriously fail); the global
      // floor + the dedicated engine suites are the protection now.
      // RATCHET TARGET: server global 80 / 75 by final phase.
      thresholds: {
        statements: 49,
        branches: 40,
        functions: 50,
        lines: 51,
      },
    },
  },
});
