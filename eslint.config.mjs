// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Flat ESLint config for the redAI monorepo.
 * Purity of the `domain` and `policy` packages is additionally enforced by a
 * behavioural test in tests/import-boundary; this config gives fast editor-time
 * feedback for the same rule.
 */
const purityForbidden = [
  { name: 'fastify', message: 'domain/policy must stay free of HTTP frameworks.' },
  { name: 'next', message: 'domain/policy must stay free of UI frameworks.' },
  { name: 'react', message: 'domain/policy must stay free of UI frameworks.' },
  { name: 'pg', message: 'domain/policy must not talk to the database directly.' },
  { name: 'dockerode', message: 'domain/policy must not drive Docker.' },
];
const purityForbiddenPatterns = ['**/apps/**', '**/packages/db/**', '**/packages/llm/**'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '.tools/**',
      '.local/**',
      'apps/web/next-env.d.ts',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      'worker/**',
      'specs/**',
      'assets/**',
      'contracts/examples/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/domain/**/*.ts', 'packages/policy/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: purityForbidden, patterns: purityForbiddenPatterns },
      ],
    },
  },
  {
    files: ['**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly' } },
  },
);
