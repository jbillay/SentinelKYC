import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.mjs'],
    // Coverage is scoped to the pure, I/O-free engines — the 80%-on-pure-engines
    // target from the v0.1 quality gates. Graph nodes, routes, and DB modules
    // are covered by the smoke + integration tiers, not unit tests.
    coverage: {
      provider: 'v8',
      include: [
        'services/qa/**',
        'services/risk/**',
        'services/sanctions/**',
        'services/screening/report.js',
        'services/party/canonical.js',
        'lib/decisionSchema.js',
      ],
      exclude: ['services/qa/narrative.js', 'services/risk/rationale.js', 'services/risk/seed.js'],
      reporter: ['text', 'lcov'],
    },
  },
});
