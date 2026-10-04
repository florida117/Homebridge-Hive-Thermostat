// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const style = {
  // Match the style already used throughout src/.
  'quotes': ['warn', 'single', { avoidEscape: true }],
  'indent': ['warn', 2, { SwitchCase: 1 }],
  'semi': ['warn', 'always'],
  'comma-dangle': ['warn', 'always-multiline'],
  'eol-last': ['warn', 'always'],
  'no-trailing-spaces': 'warn',
};

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2021,
        sourceType: 'module',
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...style,

      // Almost everything here is an async handler invoked by Homebridge or a
      // timer, where a dropped promise is an unhandled rejection and a promise
      // passed where a callback is expected is never awaited.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // The Hive API returns untyped JSON, which the parse helpers in hiveApi.ts
      // narrow into the exported interfaces. Non-null assertions are likewise
      // load-bearing around Homebridge's optional Matter API.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // The tests are plain CommonJS against the compiled plugin in dist/.
    files: ['test/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        structuredClone: 'readonly',
        Response: 'readonly',
        URL: 'readonly',
      },
    },
    rules: {
      ...style,
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
