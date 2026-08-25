import { defineConfig } from '@playwright/test';

const previewPort = Number(process.env.A3_PORT ?? 5199);

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  outputDir: './test-results/a3',
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${previewPort}`,
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'npm run start --workspace mock-oa-backend',
    url: 'http://127.0.0.1:3000/api/session?_nodelay=1',
    reuseExistingServer: true,
  },
});
