import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { startNetworkRecording } from '../packages/recorder/src/network';
import { login } from './helpers';

const locatorScript = await readFile('packages/locator/dist/el-locator.iife.js', 'utf8');

test('network-record: 加班请求按发出时间录入并结构化脱敏', async ({ page }) => {
  await page.addInitScript({ content: locatorScript });
  await login(page);
  const mutating: string[] = [];
  const recording = startNetworkRecording(page, [], (request) => mutating.push(request.requestId));
  await page.goto('/overtime/apply');
  await expect(page.getByRole('heading', { name: '加班申请' })).toBeVisible();

  await page.evaluate(async () => {
    const locator = window.__DSH_LOCATOR__;
    await locator.selectOption('加班类型', '工作日加班');
    await locator.setDateTime('开始时间', '2026-08-18 18:00:00');
    await locator.setDateTime('结束时间', '2026-08-18 21:00:00');
    locator.setInputValue(locator.byFormItem('事由', 'textarea'), '网络录制验证');
    await locator.waitFor(() => {
      const input = locator.byFormItem('审批人', 'input') as HTMLInputElement;
      return input.value !== '—' ? input.value : undefined;
    });
    locator.robustClick(await locator.resolve({ strategy: 'role', role: 'button', name: '提交' }));
    await locator.inDialog('确认提交', (dialog) => {
      const button = [...dialog.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === '确认提交',
      );
      if (!(button instanceof HTMLElement)) throw new Error('找不到确认提交按钮');
      locator.robustClick(button);
    });
  });
  await expect(page.getByText(/提交成功：OT-/)).toBeVisible();

  const records = await recording.stop();
  expect(records.length).toBeLessThanOrEqual(5);
  const approver = records.find((record) => record.url.includes('/overtime/approver'));
  const submit = records.find((record) => record.url.includes('/overtime/submit'));
  expect(approver).toBeDefined();
  expect(submit).toBeDefined();
  expect(mutating).toContain(submit?.requestId);
  expect(approver?.sanitizeMode).toBe('structured');
  expect(submit?.sanitizeMode).toBe('structured');
  expect(records.filter((record) => record.sanitizeMode === 'fallback')).toHaveLength(0);
  expect(records.every((record) => record.sanitizeMode === 'structured')).toBe(true);
  console.log(`T88_SANITIZE=${JSON.stringify(Object.fromEntries(
    ['structured', 'none', 'fallback'].map((mode) => [mode, records.filter((record) => record.sanitizeMode === mode).length]),
  ))}`);

  for (const record of records) {
    expect(record.responseTs).not.toBeNull();
    expect(record.requestTs).toBeLessThanOrEqual(record.responseTs as number);
  }
  expect((approver?.responseTs as number) - (approver?.requestTs as number)).toBeGreaterThanOrEqual(250);

  const approverToken = JSON.parse(approver?.responseBody ?? '{}').approvalToken;
  const submitToken = JSON.parse(submit?.postData ?? '{}').approvalToken;
  expect(approverToken).toMatch(/^<REDACTED:sha256:[0-9a-f]{12}>$/);
  expect(submitToken).toBe(approverToken);
  const serialized = JSON.stringify({ network: records });
  expect(serialized).not.toContain('MOCK_OA_SID');
  expect(serialized).not.toContain('mock-oa-session-secret');
  expect(serialized).not.toMatch(/"approvalToken":"(?!<REDACTED:sha256:)/);
});
