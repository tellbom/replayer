import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  workers: 4,
  outputDir: './test-results',
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npm run start --workspace mock-oa-backend',
      url: 'http://127.0.0.1:3000/api/session?_nodelay=1',
      reuseExistingServer: true,
    },
    {
      command: 'npm run dev --workspace mock-oa-frontend -- --host 127.0.0.1',
      url: 'http://127.0.0.1:5173/login',
      reuseExistingServer: true,
    },
  ],
});
