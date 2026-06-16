// Server lint — parity with web (which already lints). Flat config.
//
// The server is CommonJS (require/module.exports); the test suites are ESM
// (.mjs, vitest globals). We lint both with the right source type and globals.
// Underscore-prefixed args/vars are intentionally-unused (the codebase uses
// `_req`, `_o`, etc.) so they're ignored. See docs/architecture/TEST_STRATEGY §3.2.
import js from '@eslint/js';
import globals from 'globals';
import noOnlyTests from 'eslint-plugin-no-only-tests';

export default [
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      'var/**',
      'db/migrations/meta/**',
    ],
  },

  js.configs.recommended,

  // CommonJS application + script code.
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      // Phase 0: WARN (ratchets to ERROR in Phase 1, once in-flight WIP in
      // qa/narrative.js et al. settles). Keeps lint green + the signal visible.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ESM test files (vitest).
  {
    files: ['test/**/*.mjs'],
    plugins: { 'no-only-tests': noOnlyTests },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Phase 0: WARN (ratchets to ERROR in Phase 1, once in-flight WIP in
      // qa/narrative.js et al. settles). Keeps lint green + the signal visible.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Guard against a stray focus/skip silently shrinking the suite.
      'no-only-tests/no-only-tests': 'error',
    },
  },
];
