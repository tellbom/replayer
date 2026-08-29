import { defineConfig } from '@playwright/test';

// 覆盖矩阵摸底专用配置：fixture 服务器在每个测试内启动，不依赖 mock-oa webServer。
export default defineConfig({
  testDir: './e2e/matrix',
  workers: 2,
  outputDir: './test-results/matrix',
  reporter: [['list']],
  use: { channel: 'chrome' },
});
