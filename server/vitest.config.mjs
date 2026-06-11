import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.mjs'],
    // Coverage is scoped to the pure, I/O-free engines — the 80%-on-pure-engines
    // target from the v0.1 quality gates. Modules with I/O (graph nodes,
    // routes, DB/LLM barrels, list parsers) belong to the smoke + integration
    // tiers and are deliberately NOT in this include list.
    coverage: {
      provider: 'v8',
      include: [
        'services/qa/routingEngine.js',
        'services/qa/projectCase.js',
        'services/qa/completenessCheck.js',
        'services/qa/consistencyCheck.js',
        'services/qa/issueMap.js',
        'services/qa/index.js',
        'services/risk/factors.js',
        'services/risk/knockouts.js',
        'services/risk/thresholds.js',
        'services/sanctions/matcher.js',
        'services/sanctions/normalize.js',
        'services/screening/report.js',
        'services/party/canonical.js',
        'services/registry/merge.js',
        'services/registry/providers/mock.js',
        'services/config/secrets.js',
        'lib/decisionSchema.js',
      ],
      reporter: ['text', 'lcov'],
      // Ratchet: raise as suites grow; CI fails on regression below these.
      thresholds: {
        statements: 75,
        branches: 70,
        functions: 80,
        lines: 75,
      },
    },
  },
});
