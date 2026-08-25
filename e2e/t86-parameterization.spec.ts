import { expect, test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { parseSkill } from '@dsh/core';
import { record } from '@dsh/recorder';
import { replay } from '@dsh/replayer';

import { entryResolver, oaEntry, seedProfile } from './fixture';

test.setTimeout(120_000);

test('T-86: 工作日录制的直接 draft 以周末参数回放并真实提交 weekend', async ({ browserName }, testInfo) => {
  const recordProfile = testInfo.outputPath(`record-profile-${browserName}`);
  await seedProfile(recordProfile);
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  const session = await record({
    entry: oaEntry,
    profileDir: recordProfile,
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
        await locator.waitFor(() => {
          const approver = locator.byFormItem('审批人', 'input') as HTMLInputElement;
          return approver.value !== '—' ? approver.value : undefined;
        });
        await locator.setDateTime('开始时间', '2026-08-23 09:00:00');
        await locator.setDateTime('结束时间', '2026-08-23 12:00:00');
        locator.setInputValue(locator.byFormItem('事由', 'textarea'), 'T86 workday recording');
        locator.robustClick(await locator.resolve({ strategy: 'role', role: 'button', name: '提交' }));
        await locator.inDialog('确认提交', (dialog) => {
          const confirm = [...dialog.querySelectorAll('button')].find(
            (button) => button.textContent?.trim() === '确认提交',
          );
          if (!(confirm instanceof HTMLElement)) throw new Error('找不到确认提交按钮');
          locator.robustClick(confirm);
        });
      });
      await page.getByText(/提交成功：OT-/).waitFor();
      stop();
    },
  });

  const comparisonProfile = testInfo.outputPath(`comparison-profile-${browserName}`);
  await seedProfile(comparisonProfile);
  let stopComparison!: () => void;
  const comparisonStopSignal = new Promise<void>((resolve) => { stopComparison = resolve; });
  const comparisonSession = await record({
    entry: oaEntry,
    profileDir: comparisonProfile,
    outDir: testInfo.outputPath('comparison-recording'),
    channel: 'chrome',
    headless: true,
    stopSignal: comparisonStopSignal,
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/overtime/apply');
      await page.locator('.el-form-item').first().waitFor();
      await page.evaluate(async () => {
        const locator = window.__DSH_LOCATOR__;
        await locator.selectOption('加班类型', '周末加班');
        await locator.waitFor(() => {
          const approver = locator.byFormItem('审批人', 'input') as HTMLInputElement;
          return approver.value !== '—' ? approver.value : undefined;
        });
      });
      stopComparison();
    },
  });

  const draft = generateDraft(session, comparisonSession);
  const skill = parseSkill(draft.yaml, entryResolver());
  const type = skill.params.find((param) => param.name === 'type');
  const typeBodies = skill.steps
    .filter((step) => step.network?.body && 'type' in step.network.body)
    .map((step) => step.network?.body?.type);
  expect(type?.enumMap).toEqual({
    工作日加班: 'workday',
    周末加班: 'weekend',
  });
  expect(typeBodies).not.toContain('{{s4[0].value}}');
  expect(typeBodies.every((value) => value === '{{type|enumValue}}')).toBe(true);

  const replayProfile = testInfo.outputPath(`replay-profile-${browserName}`);
  await seedProfile(replayProfile);
  const reason = `T86 weekend replay ${Date.now()}`;
  const result = await replay(skill, {
    params: {
      type: '周末加班',
      startTime: '2026-08-23 13:00:00',
      endTime: '2026-08-23 16:00:00',
      reason,
    },
    profileDir: replayProfile,
    entry: oaEntry,
    noLLM: true,
    onConfirm: async () => true,
  });
  expect(result.ok, JSON.stringify(result)).toBe(true);

  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(replayProfile, { channel: 'chrome', headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('http://127.0.0.1:15173/home');
    const history = await page.evaluate(() =>
      fetch('/api/overtime/history?limit=20', { credentials: 'include' }).then((response) => response.json()),
    ) as { list: Array<{ reason: string; type: string }> };
    const stored = history.list.find((item) => item.reason === reason);
    console.log(`T86_HISTORY=${JSON.stringify(stored)}`);
    expect(stored?.type).toBe('weekend');
  } finally {
    await context.close();
  }
});
