import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { login } from './helpers';

const snapshotScript = await readFile('packages/locator/dist/snapshot.iife.js', 'utf8');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: snapshotScript });
  await login(page);
});

test('snapshot: 加班页快照紧凑且包含全部交互元素', async ({ page }) => {
  await page.goto('/overtime/apply');
  await expect(page.getByRole('heading', { name: '加班申请' })).toBeVisible();
  const snapshot = await page.evaluate(() => window.__DSH_SNAPSHOT__());

  expect(Math.ceil(snapshot.length / 2.5)).toBeLessThan(2_000);
  expect(snapshot.length).toBeLessThanOrEqual(8_000);
  for (const text of ['加班类型', '开始时间', '结束时间', '事由', '审批人', '提交']) {
    expect(snapshot).toContain(text);
  }
});

test('snapshot: 弹窗打开时只输出弹窗内容', async ({ page }) => {
  await page.goto('/overtime/apply');
  await page.getByRole('button', { name: '提交', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认提交' })).toBeVisible();
  const snapshot = await page.evaluate(() => window.__DSH_SNAPSHOT__());

  expect(snapshot).toContain('[对话框: 确认提交]');
  expect(snapshot).not.toContain('[页面]');
  expect(snapshot).not.toContain('加班类型');
});

test('snapshot: 表格最多输出前 5 行', async ({ page }) => {
  await page.goto('/history');
  await expect(page.getByText('OT-HISTORY-0001', { exact: true })).toBeVisible();
  const snapshot = await page.evaluate(() => window.__DSH_SNAPSHOT__());

  expect(snapshot).toContain('OT-HISTORY-0001');
  expect(snapshot).toContain('OT-HISTORY-0005');
  expect(snapshot).not.toContain('OT-HISTORY-0006');
  expect(snapshot).toContain('… 共 20 行');
});
