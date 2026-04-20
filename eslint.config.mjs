import tsParser from '@typescript-eslint/parser'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import js from '@eslint/js'
import { FlatCompat } from '@eslint/eslintrc'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const compat = new FlatCompat({
  baseDirectory: __dirname,
  recommendedConfig: js.configs.recommended,
  allConfig: js.configs.all,
})

const consoleAllowedFiles = [
  '**/src/cli.{ts,tsx,js,mjs,cjs}',
  '**/src/cli/**',
  '**/src/bin.{ts,tsx,js,mjs,cjs}',
  '**/src/bin/**',
  '**/scripts/**',
  '**/demo/**',
  '**/docs/**',
  '**/e2e/**',
  'apps/supabase/**',
  'apps/**/e2e/**',
  '**/__tests__/**',
  '**/*.{test,spec}.{ts,tsx,js,mjs,cjs}',
  '**/*.test.sh',
]

export default [
  ...compat.extends('plugin:@typescript-eslint/recommended', 'plugin:prettier/recommended'),
  {
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/ban-ts-comment': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'pino',
              message: 'Import from @stripe/sync-logger instead of pino directly.',
            },
          ],
        },
      ],
      'prettier/prettier': 'warn',
    },
  },
  {
    files: ['packages/logger/**'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },
  {
    files: consoleAllowedFiles,
    rules: {
      'no-console': 'off',
    },
  },
]
