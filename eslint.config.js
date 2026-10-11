// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const nodeGlobals = require('globals').node;
const jestGlobals = require('globals').jest;

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'android/*', 'ios/*', 'coverage/*', '.expo/*', 'node_modules/*', 'functions/*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    // Tests and tooling may use console output freely.
    files: ['test/**/*.ts', 'test/**/*.tsx', '**/*.test.ts', '**/*.test.tsx', 'scripts/**/*.js', 'app.config.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Build and signing scripts run under Node, not in the app bundle, so they may use the
    // Node globals. Without this every `__dirname` and `Buffer` in scripts/ reads as undefined --
    // which nothing noticed for a while, because `expo lint` does not reach scripts/ at all.
    files: ['scripts/**/*.js'],
    languageOptions: { globals: nodeGlobals },
  },
  {
    // The plain-JS tests in test/ run under Node AND under Jest: `require` and `__dirname` as
    // well as `describe`, `it` and `expect`. Without both sets every line of them is a
    // `no-undef` error -- which `expo lint` never showed, because it does not reach test/ either.
    files: ['test/**/*.js'],
    languageOptions: { globals: { ...nodeGlobals, ...jestGlobals } },
  },
]);
