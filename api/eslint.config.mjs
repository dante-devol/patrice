// @ts-check
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the API tier (NestJS + Prisma). Pragmatic, non-type-checked
 * ruleset (fast, low false-positive) — the source of truth for correctness stays
 * `tsc` + the jest suites; lint guards the stylistic/footgun layer. See issue #34.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.config.mjs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // TS already proves these; the core rules duplicate/misfire on TS syntax.
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The codebase deliberately uses `any` at a few I/O boundaries (Cedar entities,
      // Prisma JSON) where a precise type buys little; keep it as a nudge, not a block.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      // Server code logs through the Nest Logger; the one deliberate stdout write
      // (the bootstrap key) carries an inline disable, which this keeps meaningful.
      'no-console': 'warn',
    },
  },
  {
    // Test + script files: jest globals, and they may reach for looser patterns.
    files: ['test/**/*.ts', 'src/**/*.spec.ts', 'scripts/**/*'],
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  {
    // CommonJS ops/smoke scripts (run via `node scripts/*.js`): require() is correct
    // here — the package is `type: commonjs` and these load the compiled dist.
    files: ['scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
