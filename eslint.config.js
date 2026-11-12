import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import hooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/', 'node_modules/', 'storage/', 'backups/'] },
  js.configs.recommended,
  { files: ['server/**/*.js', 'tests/**/*.js', 'scripts/**/*.mjs', 'vite.config.js', 'eslint.config.js'], languageOptions: { globals: globals.node, sourceType: 'module' } },
  {
    files: ['src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': hooks },
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    settings: { react: { version: '18' } },
    rules: { 'react/jsx-uses-vars': 'error', 'react/jsx-uses-react': 'off', 'react-hooks/rules-of-hooks': 'error' },
  },
  { files: ['src/__tests__/**'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  { files: ['public/sw.js'], languageOptions: { globals: globals.serviceworker } },
  { rules: { 'no-unused-vars': ['warn', { argsIgnorePattern: '^_', ignoreRestSiblings: true, varsIgnorePattern: '^_|^React$', caughtErrors: 'none' }], 'no-empty': ['error', { allowEmptyCatch: true }] } },
]
