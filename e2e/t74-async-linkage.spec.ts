import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { StepSchema, type ExecContext } from '@dsh/core';
import { record } from '@dsh/recorder';

import { executeUiStep } from '../packages/replayer/src/channel-ui.js';
import { oaEntry } from './fixture.js';
import { login } from './helpers.js';

const locatorScript = await readFile('packages/locator/dist/el-locator.iife.js', 'utf8');

test('T-74 录制选择联动时推导请求与审批人非空等待', async ({ browserName }, testInfo) => {
  test.setTimeout(120_000);
  const profileDir = testInfo.outputPath(`profile-${browserName}`);
  await seedPersistentProfile(profileDir);
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });

  const session = await record({
    entry: oaEntry,
    profileDir,
    outDir: testInfo.outputPath('record'),
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').filter({ hasText: '加班类型' }).locator('.el-select').click();
      await page.getByRole('option', { name: '工作日加班' }).click();
      await expect(page.getByLabel('审批人')).toHaveValue('张经理');
      stop();
    },
  });

  const selection = session.actions.find(
    (action) => action.type === 'select' && action.value === '工作日加班',
  );
  expect(selection?.waitAfter).toMatchObject({
    requestUrlPattern: '/api/overtime/approver',
    notEmpty: { strategy: 'el-form-item', label: '审批人', kind: 'input' },
    timeoutMs: 8_000,
  });
  expect(selection?.waitAfter?.settleMs).toBeUndefined();
});

async function seedPersistentProfile(profileDir: string): Promise<void> {
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('http://127.0.0.1:15173/login');
    await page.evaluate(() =>
      fetch('/api/login?cookieMode=persistent&_nodelay=1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'tester', password: 'tester' }),
      }),
    );
  } finally {
    await context.close();
  }
}

test('T-74 回放在动作前监听响应并等待审批人赋值', async ({ page }) => {
  await page.addInitScript({ content: locatorScript });
  await login(page);
  await page.goto('/overtime/apply');
  await expect(page.getByRole('option', { name: '周末加班' })).toHaveCount(0);
  await page.locator('.el-select').waitFor();

  const step = StepSchema.parse({
    id: 'select-overtime-type',
    desc: '选择加班类型',
    channel: 'ui',
    ui: { action: 'selectOption', label: '加班类型', value: '周末加班' },
    waitAfter: {
      requestUrlPattern: '/api/overtime/approver',
      notEmpty: { strategy: 'el-form-item', label: '审批人', kind: 'input' },
      timeoutMs: 2_000,
    },
  });
  const context: ExecContext = {
    params: {},
    vars: {},
    stepResults: {},
    baseUrl: 'http://127.0.0.1:15173',
    entry: oaEntry,
    identityDigest: 'tester',
    scopes: {},
  };

  const startedAt = Date.now();
  await executeUiStep(page, step, context, []);
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(450);
  await expect(page.getByLabel('审批人')).toHaveValue('李总监');
});
