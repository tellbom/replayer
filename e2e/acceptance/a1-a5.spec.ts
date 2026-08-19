import { expect, test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { ForbiddenError, parseSkill } from '@dsh/core';
import type { RecordSession, Skill, Step } from '@dsh/core';
import { record } from '@dsh/recorder';
import { chromium } from 'playwright';
import { replay } from '@dsh/replayer';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { oaEntry, entryResolver, seedProfile } from '../fixture';

const baseUrl = 'http://127.0.0.1:5173';

test('A1 录制加班并生成可解析 draft.yaml', async () => {
  const session = await recordBusiness('/overtime/apply', async (page) => {
    await completeForm(page, '加班类型', '工作日加班', '审批人', 'A1 录制验收');
    await expect(page.getByText(/提交成功/)).toBeVisible();
  });
  const draft = generateDraft(session);
  expect(parseSkill(draft.yaml, entryResolver()).steps.length).toBeGreaterThan(0);
});

test('A2 修正技能可稳定回放', async ({ browserName }, testInfo) => {
  await seedProfile(testInfo.outputPath(`profile-${browserName}`));
  const skill = await loadOvertimeSkill();
  const result = await replay(skill, {
    params: overtimeParams(`A2-${testInfo.repeatEachIndex}`),
    profileDir: testInfo.outputPath(`profile-${browserName}`),
    entry: oaEntry,
    noLLM: true,
    onConfirm: async () => true,
  });
  expect(result.ok).toBe(true);
  expect(result.steps.find((step) => step.stepId === 'submit')).toMatchObject({
    ok: true,
    outcome: 'confirmed_success',
  });
});

test('A4 同一录制器无需改代码即可录制请假流程', async () => {
  const session = await recordBusiness('/leave/apply', async (page) => {
    await completeForm(page, '请假类型', '年假', '可用余额', 'A4 请假录制');
    await expect(page.getByText(/提交成功/)).toBeVisible();
  });
  const draft = generateDraft(session);
  expect(parseSkill(draft.yaml, entryResolver()).steps.length).toBeGreaterThan(0);
});

test('A5 network 通道单步提交小于 2 秒', async ({ browserName }, testInfo) => {
  await seedProfile(testInfo.outputPath(`profile-${browserName}`));
  const result = await replay(await loadOvertimeSkill(), {
    params: overtimeParams('A5 性能验收'),
    profileDir: testInfo.outputPath(`profile-${browserName}`),
    entry: oaEntry,
    noLLM: true,
    onConfirm: async () => true,
  });
  const submit = result.steps.find((step) => step.stepId === 'submit');
  expect(submit?.ok).toBe(true);
  expect(submit?.durationMs).toBeLessThan(2_000);
});

test('S1 drop_response 只产生一条业务数据且不自动 UI 重提', async ({ browserName }, testInfo) => {
  await seedProfile(testInfo.outputPath(`profile-${browserName}`));
  const skill = await loadOvertimeSkill();
  const submit = skill.steps.find((step) => step.id === 'submit')!;
  submit.network!.url = '/api/overtime/submit?drop_response=1';
  skill.assertions = [];
  skill.steps.push(debugStep());
  const result = await replay(skill, {
    params: overtimeParams('S1 响应丢失验收'),
    profileDir: testInfo.outputPath(`profile-${browserName}`),
    entry: oaEntry,
    noLLM: true,
    onConfirm: async () => true,
  });
  const resolved = result.steps.find((step) => step.stepId === 'submit');
  expect(resolved).toMatchObject({
    outcome: 'confirmed_success',
    outcomeResolvedBy: 'postcondition',
  });
  const debug = result.steps.find((step) => step.stepId === 'debug');
  expect((JSON.parse(debug?.raw?.text ?? '{}') as { count: number }).count).toBe(1);
});

test('S2 403 直接失败且不触发登录循环或业务重试', async ({ browserName }, testInfo) => {
  const skill = await loadOvertimeSkill();
  skill.steps = [
    ...skill.steps.slice(0, 3),
    {
      id: 'forbidden', desc: '403 专项', channel: 'network', riskLevel: 'read', hasSideEffect: false,
      network: { method: 'GET', url: '/api/_debug/forbidden', contentType: 'json' },
    },
  ];
  let failure: (ForbiddenError & { diagnosticDir?: string }) | undefined;
  await seedProfile(testInfo.outputPath(`profile-${browserName}`));
  try {
    await replay(skill, {
      params: overtimeParams('S2'),
      profileDir: testInfo.outputPath(`profile-${browserName}`),
      entry: oaEntry,
      noLLM: true,
    });
  } catch (error) {
    failure = error as ForbiddenError & { diagnosticDir?: string };
  }
  expect(failure).toBeInstanceOf(ForbiddenError);
  const dom = await readFile(join(failure!.diagnosticDir!, 'step-forbidden-dom.html'), 'utf8');
  expect(dom).not.toContain('__dsh_login_hint__');
});

async function recordBusiness(
  path: string,
  action: (page: import('@playwright/test').Page) => Promise<void>,
): Promise<RecordSession> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-acceptance-record-'));
  const profile = join(root, 'profile');
  // 种子门户会话（等价于用户此前登录过一次——C16：登录不进入录制）
  const seed = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: true });
  {
    const page = seed.pages()[0] ?? (await seed.newPage());
    await page.goto(`${baseUrl}/login`);
    await page.getByLabel('用户名').fill('tester');
    await page.getByLabel('密码').fill('tester');
    await page.getByRole('button', { name: '登录' }).click();
    await page.waitForURL('**/home');
  }
  await seed.close();

  let stop!: () => void;
  const stopSignal = new Promise<void>((resolveStop) => { stop = resolveStop; });
  return record({
    entry: oaEntry,
    profileDir: profile,
    outDir: join(root, 'recording'),
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto(`${baseUrl}${path}`);
      await page.locator('.el-form-item').first().waitFor();
      await action(page);
      stop();
    },
  });
}

async function completeForm(
  page: import('@playwright/test').Page,
  typeLabel: string,
  typeValue: string,
  loadedLabel: string,
  reason: string,
): Promise<void> {
  await page.evaluate(async ({ typeLabel, typeValue, loadedLabel, reason }) => {
    const locator = window.__DSH_LOCATOR__;
    await locator.selectOption(typeLabel, typeValue);
    await locator.setDateTime('开始时间', '2026-08-19 18:00:00');
    await locator.setDateTime('结束时间', '2026-08-19 21:00:00');
    locator.setInputValue(locator.byFormItem('事由', 'textarea'), reason);
    await locator.waitFor(() => {
      const input = locator.byFormItem(loadedLabel, 'input') as HTMLInputElement;
      return input.value && input.value !== '—' ? input.value : undefined;
    });
    locator.robustClick(await locator.resolve({ strategy: 'role', role: 'button', name: '提交' }));
    await locator.inDialog('确认提交', (dialog) => {
      const button = [...dialog.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === '确认提交',
      );
      if (!(button instanceof HTMLElement)) throw new Error('找不到确认提交按钮');
      locator.robustClick(button);
    });
  }, { typeLabel, typeValue, loadedLabel, reason });
  await expect(page.getByText(/提交成功/)).toBeVisible();
}

async function loadOvertimeSkill(): Promise<Skill> {
  return parseSkill(await readFile('skills/oa_overtime_submit.yaml', 'utf8'), entryResolver());
}

function overtimeParams(reason: string): Record<string, string> {
  return {
    type: '工作日加班',
    startTime: '2026-08-19 18:00:00',
    endTime: '2026-08-19 21:00:00',
    reason,
  };
}

function debugStep(): Step {
  return {
    id: 'debug', desc: '读取提交数', channel: 'network', riskLevel: 'read', hasSideEffect: false,
    network: { method: 'GET', url: '/api/_debug/submissions', contentType: 'json' },
  };
}
