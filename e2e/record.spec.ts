import { expect, test } from '@playwright/test';
import type { RecordSession } from '@dsh/core';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { record } from '../packages/recorder/src/session';
import { oaEntry, seedProfile } from './fixture';

test('record e2e: 脚本化加班流程产出完整录制', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-record-e2e-'));
  const profileDir = join(root, 'profile');
  await seedProfile(profileDir);
  await record({
    entry: oaEntry,
    profileDir,
    outDir: join(root, 'out'),
    channel: 'chrome',
    headless: true,
    stopSignal: Promise.resolve(),
    onReady: async (page) => {
      await page.goto('/overtime/apply');
      await expect(page.getByRole('heading', { name: '加班申请' })).toBeVisible();

      await page.evaluate(async () => {
        const locator = window.__DSH_LOCATOR__;
        await locator.selectOption('加班类型', '工作日加班');
        await locator.setDateTime('开始时间', '2026-08-18 18:00:00');
        await locator.setDateTime('结束时间', '2026-08-18 21:00:00');
        locator.setInputValue(locator.byFormItem('事由', 'textarea'), '录制器端到端验收');
        await locator.waitFor(() => {
          const approver = locator.byFormItem('审批人', 'input') as HTMLInputElement;
          return approver.value !== '—' ? approver.value : undefined;
        });
        locator.robustClick(
          await locator.resolve({ strategy: 'role', role: 'button', name: '提交' }),
        );
        await locator.inDialog('确认提交', (dialog) => {
          const confirm = [...dialog.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === '确认提交',
          );
          if (!(confirm instanceof HTMLElement)) throw new Error('找不到确认提交按钮');
          locator.robustClick(confirm);
        });
      });
      await expect(page.getByText(/提交成功：OT-/)).toBeVisible();
    },
  });

  const stored: RecordSession = JSON.parse(
    await readFile(join(root, 'out', 'record.json'), 'utf8'),
  );
  expect(stored.actions).toEqual([]);
  const canonical = stored.canonicalActions ?? [];
  const overtimeStart = canonical.findLastIndex(
    (action) => action.kind === 'navigate' && action.effects?.navigation?.url.endsWith('/overtime/apply'),
  );
  expect(canonical.slice(overtimeStart).map((action) => action.kind)).toEqual([
    'navigate',
    'activate',
    'select',
    'edit',
    'edit',
    'edit',
    'activate',
    'activate',
  ]);
  expect(stored.recorderPath).toBe('canonical');
  expect(stored.canonicalActions?.length).toBeGreaterThan(0);
  expect(stored.canonicalActions?.every((action) => action.raw.eventTypes.length > 0)).toBe(true);
  const approver = stored.network.find((request) => request.url.includes('/overtime/approver'));
  const submit = stored.network.find((request) => request.url.includes('/overtime/submit'));
  expect(approver?.sanitizeMode).toBe('structured');
  expect(submit?.sanitizeMode).toBe('structured');
  expect(approver?.requestTs).toBeLessThanOrEqual(approver?.responseTs as number);
  expect(submit?.requestTs).toBeLessThanOrEqual(submit?.responseTs as number);
  expect(stored.pages.some((item) => item.url.endsWith('/overtime/apply'))).toBe(true);
  expect(JSON.stringify(stored)).not.toMatch(/"approvalToken":"(?!<REDACTED:sha256:)/);
});
