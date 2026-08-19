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
  // node_modules/@dsh 的 Windows 联接点在当前环境无法穿越，
  // 用别名把 @dsh/* 直接指到各包源码入口（与 tsconfig paths 一致）。
  resolve: {
    alias: {
      '@dsh/core': '/packages/core/src/index.ts',
      '@dsh/locator': '/packages/locator/src/index.ts',
      '@dsh/browser': '/packages/browser/src/index.ts',
      '@dsh/recorder': '/packages/recorder/src/index.ts',
      '@dsh/analyzer': '/packages/analyzer/src/index.ts',
      '@dsh/replayer': '/packages/replayer/src/index.ts',
      '@dsh/llm': '/packages/llm/src/index.ts',
      '@dsh/cli': '/packages/cli/src/index.ts',
    },
  },
});
