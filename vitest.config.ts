import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit + boundary tests run without external services.
    // Integration suites (db, contracts) opt in via their own workspace tsconfig
    // and are gated on service availability inside the test files.
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
    passWithNoTests: false,
  },
});
