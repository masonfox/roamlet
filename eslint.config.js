const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

// src/core stays platform-free (design.md, Decision 6).
const PLATFORM_MODULE = '^(?:react-native|expo)(?:[-/].*)?$|^@(?:expo|react-native)/';
const PLATFORM_MESSAGE = 'src/core must stay platform-free: no react-native or expo imports.';
// esquery regex literals cannot contain a slash.
const PLATFORM_SELECTOR = `/${PLATFORM_MODULE.replaceAll('/', '\\x2F')}/`;

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*', 'web-build/*', '.expo/*', 'android/*', 'ios/*'],
  },
  {
    files: ['src/core/**', 'test/core/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: PLATFORM_MODULE, message: PLATFORM_MESSAGE }] },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: `CallExpression[callee.name='require'][arguments.0.value=${PLATFORM_SELECTOR}]`,
          message: PLATFORM_MESSAGE,
        },
        {
          selector: `ImportExpression[source.value=${PLATFORM_SELECTOR}]`,
          message: PLATFORM_MESSAGE,
        },
      ],
    },
  },
]);
