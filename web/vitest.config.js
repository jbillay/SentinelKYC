import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// Web test harness — Phase 0. See docs/architecture/TEST_STRATEGY.md §7.1.
//
// jsdom so components mount; @vitejs/plugin-vue so .vue SFCs compile. Coverage
// is whole-codebase (`all: true`) over src/, minus the bootstrap + router glue
// that's exercised by the app, not units. Thresholds start at 0 (no suites yet
// beyond the Phase-0 smokes) and ratchet to 80/75 by Phase 5 as suites land.
export default defineConfig({
  // Disable asset-URL transforms so <img src="/logo.png"> stays a plain string
  // in the jsdom test environment instead of triggering a module resolution.
  plugins: [vue({ template: { transformAssetUrls: false } })],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.js'],
    include: ['test/**/*.{test,spec}.js', 'src/**/*.{test,spec}.js'],
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.{js,vue}'],
      exclude: [
        'src/main.js',
        'src/router/**',
        'src/styles/**',
        '**/*.config.*',
      ],
      reporter: ['text', 'text-summary', 'lcov'],
      // RATCHET FLOOR — raised at each phase end, never lowered.
      //   Phase 0: harness only (0).
      //   Phase 2 (2026-06-13): stmts 10.8 / br 6.51 / fn 8.06 / ln 11.49 —
      //     lib + stores + useDecision covered (lib 96%, stores 74%). The
      //     low global is expected: components (8.6k LOC) land in Phase 5.
      //   Phase 5b (2026-06-14): stmts 32.2 / br 20.16 / fn 23.85 / ln 34.83 —
      //     10 fetch composables + 4 store composables + 5 display components
      //     + 8 page smoke tests (181 tests, 4 new suites).
      //   Phase 5c (2026-06-15): stmts 63.47 / br 40.45 / fn 48.47 / ln 68.13 —
      //     17 components (CountryFlag … FinalDecisionPanel) + 6 pages
      //     (RunPage, DossierViewPage, RunDetailPage, RunDiffPage, PartyDetailPage,
      //     AdminPage) + server integration stubs (244 tests, 16 suites).
      //   Phase 5d (2026-06-15): stmts 68.89 / br 47.26 / fn 53.59 / ln 73.44 —
      //     AppShell + AgentsPanel + ProcessTab/DataModelTab + agent store hydrate +
      //     useRun actions + useScreening carry-forward/rescreen (56 tests, 1 suite).
      //   Phase 5e (2026-06-15): stmts 74.60 / br 55.72 / fn 61.00 / ln 78.94 —
      //     ShareholderGraph + AgentTrail branches + FinalDecisionPanel forms +
      //     ScreeningTab filters/actions + WatchlistPage + AuditLogPage +
      //     KycCard branch push + PartyDetailPage smoke (116 tests, 1 suite).
      //   Phase 5f+5g (2026-06-15): stmts 83.07 / br 69.77 / fn 75.05 / ln 87.06 —
      //     AdminPage + Parties + PartyDetail + HealthIndicator + ScreeningHitPanel
      //     (5f) and DossierViewPage + RunPage + ProcessTab (5g), authored in
      //     parallel worktree sessions (516 tests, 18 suites). Stmts + lines now
      //     past the 80 target; branches (need +5) and functions (need +5) remain.
      // RATCHET TARGET: web global 80 / 75 by Phase 5.
      thresholds: {
        statements: 81,
        branches: 67,
        functions: 73,
        lines: 85,
        // Per-file guards lock the well-covered pure layer.
        'src/lib/countries.js': { statements: 90, branches: 85, functions: 100, lines: 95 },
        'src/lib/api.js': { statements: 90, branches: 75, functions: 100, lines: 95 },
        'src/stores/dossier.js': { statements: 85, branches: 75, functions: 100, lines: 90 },
        'src/stores/decision.js': { statements: 85, branches: 70, functions: 100, lines: 95 },
        'src/stores/health.js': { statements: 90, branches: 65, functions: 100, lines: 90 },
        'src/stores/auth.js': { statements: 85, branches: 35, functions: 70, lines: 90 },
      },
    },
  },
})
