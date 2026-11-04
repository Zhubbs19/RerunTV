// ESLint flat config (`npm run lint`, run in CI). Main-process code, scripts and
// unit tests are CommonJS on Node; renderer code and plugin on-screen code are
// ES modules in the browser. Untracked folders are skipped through .gitignore,
// and the companion apps have their own TypeScript checks.
const path = require('node:path');
const js = require('@eslint/js');
const globals = require('globals');
const { includeIgnoreFile } = require('@eslint/compat');

module.exports = [
  includeIgnoreFile(path.join(__dirname, '.gitignore')),
  {
    ignores: [
      '.claude/**',
      'companion-rn/**',
      'android-tv-client/**',
      'android-companion-client/**',
      'build/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  {
    // Older eslint-disable comments name rules this config doesn't turn on.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      // Empty catch blocks are the codebase's "best effort, ignore failure" idiom.
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: [
      'renderer/**/*.js',
      'plugins/*/renderer.js',
      'plugins/*/settings.js',
      'plugin-dev-kit/**/renderer.js',
      'plugin-dev-kit/**/settings.js',
    ],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser },
    },
  },
  {
    // The website (site/, a Vite + React app). vite.config.mjs defines __SITE_INFO__. Without a
    // React lint plugin (none supports ESLint 10 yet), a component used only in JSX looks unused,
    // so capitalized names are exempt.
    files: ['site/src/**/*.js', 'site/src/**/*.jsx'],
    languageOptions: {
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, __SITE_INFO__: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^(_|[A-Z])',
        ignoreRestSiblings: true,
      }],
    },
  },
  {
    // Older plugins read the shared app state through the window.S global app.js sets.
    files: ['plugins/*/renderer.js', 'plugins/*/settings.js'],
    languageOptions: { globals: { S: 'readonly' } },
  },
  {
    // Plain scripts served to phones by a plugin's LAN page (no modules, no build step).
    files: ['plugins/companion-app/remote/remote.js', 'plugins/party-channel/party/party.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },
];
