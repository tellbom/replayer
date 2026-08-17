import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/src/**/*.test.ts', 'tests/**/*.test.ts', 'e2e/**/*.unit.test.ts'],
    passWithNoTests: true,
  },
});
