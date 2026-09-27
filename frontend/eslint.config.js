import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  // The validation suite, analysis runs and their configs run in Node, not the browser.
  {
    files: ['validation/**/*.js', 'analysis/**/*.js', 'vitest.validation.config.js', 'vitest.analysis.config.js'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
])
