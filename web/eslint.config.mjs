// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

/**
 * Flat ESLint config for the web tier (Angular 19, standalone + signals). Uses the
 * angular-eslint recommended sets for TS and templates. Component/directive selector
 * prefixes are relaxed to a warning — this app uses bare element selectors
 * (`divisions-admin`, `notification-bell`) rather than a `app-` prefix. See issue #34.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.angular/**'] },
  {
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
      ...angular.configs.tsRecommended,
    ],
    processor: angular.processInlineTemplates,
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The app deliberately uses unprefixed element selectors.
      '@angular-eslint/component-selector': 'off',
      '@angular-eslint/directive-selector': 'off',
    },
  },
  {
    files: ['**/*.spec.ts'],
    languageOptions: { globals: { ...globals.jest } },
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
  {
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended],
    rules: {},
  },
);
