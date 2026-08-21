import { expect, test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { record } from '@dsh/recorder';

import { oaEntry, seedProfile } from './fixture';

test.setTimeout(90_000);

test('T-87: delayed approver request remains owned by the select action under fast input', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`profile-${browserName}`);
  await seedProfile(profileDir);
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  const session = await record({
    entry: oaEntry,
    profileDir,
    outDir: testInfo.outputPath('recording'),
    channel: 'chrome',
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(async () => {
        const locator = window.__DSH_LOCATOR__;
        await locator.selectOption('加班类型', '工作日加班');
        await locator.setDateTime('开始时间', '2026-08-23 09:00:00');
        await locator.setDateTime('结束时间', '2026-08-23 12:00:00');
        locator.setInputValue(locator.byFormItem('事由', 'textarea'), 'T87 fast cadence');
        await locator.waitFor(() => {
          const approver = locator.byFormItem('审批人', 'input') as HTMLInputElement;
          return approver.value !== '—' ? approver.value : undefined;
        });
      });
      stop();
    },
  });

  const { skill } = generateDraft(session);
  const approver = skill.steps.find((step) => step.network?.url.includes('/overtime/approver'));
  const owner = skill.steps.find((step) => step.id === approver?._correlation?.ownerAction);
  console.log(`T87_CORRELATION=${JSON.stringify(approver?._correlation)}`);
  expect(owner?.ui?.action).toBe('selectOption');
  expect(approver?._correlation).toMatchObject({
    method: 'request-value-match',
    confidence: 'high',
  });
});

test('T-87: request value causality remains high confidence with a slow recording cadence', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`profile-${browserName}`);
  await seedProfile(profileDir);
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  const session = await record({
    entry: oaEntry,
    profileDir,
    outDir: testInfo.outputPath('recording'),
    channel: 'chrome',
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(async () => {
        const locator = window.__DSH_LOCATOR__;
        await locator.selectOption('加班类型', '工作日加班');
      });
      await page.waitForTimeout(1_600);
      await page.evaluate(() => {
        const locator = window.__DSH_LOCATOR__;
        locator.setInputValue(locator.byFormItem('事由', 'textarea'), 'T87 slow cadence');
      });
      stop();
    },
  });

  const { skill } = generateDraft(session);
  const approver = skill.steps.find((step) => step.network?.url.includes('/overtime/approver'));
  const owner = skill.steps.find((step) => step.id === approver?._correlation?.ownerAction);
  console.log(`T87_SLOW_CORRELATION=${JSON.stringify(approver?._correlation)}`);
  expect(owner?.ui?.action).toBe('selectOption');
  expect(approver?._correlation).toMatchObject({
    method: 'request-value-match',
    confidence: 'high',
  });
});
