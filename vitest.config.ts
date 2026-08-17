import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.{ts,js}',
      'apps/**/src/**/*.test.{ts,js}',
      'tests/**/*.test.{ts,js}',
      'e2e/**/*.unit.test.{ts,js}',
    ],
    passWithNoTests: true,
  },
});
