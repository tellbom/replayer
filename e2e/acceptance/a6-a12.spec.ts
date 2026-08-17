import { expect, test } from '@playwright/test';
import { recoverAuthentication } from '@dsh/browser';
import { parseSkill } from '@dsh/core';
import type { ExecContext, ILLMProvider, LocatorStrategy, Skill, Step } from '@dsh/core';
import { executeHeal, proposeHeal } from '@dsh/llm';
import { executePreflights } from '@dsh/replayer';
import { runNaturalLanguage } from '../../packages/cli/src/run';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { login } from '../helpers';

const locatorScript = await readFile('packages/locator/dist/el-locator.iife.js', 'utf8');
const snapshotScript = await readFile('packages/locator/dist/snapshot.iife.js', 'utf8');
const auth = {
  probeUrl: '/home', sessionApi: '/api/session?_nodelay=1', loggedInJsonPath: '$.loggedIn',
  loginUrlPatterns: ['/login'], loginDomMarkers: ['input[type="password"]'], loginTimeoutMs: 10_000,
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: locatorScript });
  await page.addInitScript({ content: snapshotScript });
});

test('A6 五种文案变化至少四种能 resolve，自愈写动作确认后才写回', async ({ page }) => {
  await login(page);
  const variants: Array<{
    old: LocatorStrategy; target: LocatorStrategy; action: NonNullable<Step['ui']>['action'];
    mutate: () => Promise<void>; evidence: string;
  }> = [
    labelVariant(page, '事由', '加班原因', 'textarea', 'fill'),
    labelVariant(page, '开始时间', '加班开始', 'datepicker', 'setDateTime'),
    labelVariant(page, '结束时间', '加班结束', 'datepicker', 'setDateTime'),
    labelVariant(page, '加班类型', '加班类别', 'select', 'selectOption'),
    {
      old: { strategy: 'text', text: '提交' },
      target: { strategy: 'text', text: '发送申请' },
      action: 'click', evidence: '"发送申请"',
      mutate: async () => page.getByRole('button', { name: '提交', exact: true }).evaluate((button) => {
        button.textContent = '发送申请';
      }),
    },
  ];
  const candidates = [];
  for (const [index, variant] of variants.entries()) {
    await page.goto('/overtime/apply');
    await page.locator('.el-form-item').first().waitFor();
    await variant.mutate();
    const step = healStep(`variant-${index}`, variant.action, variant.old, index === 4);
    const candidate = await proposeHeal({
      llm: mockLLM([{ target: variant.target, evidence: variant.evidence }]),
      page, step, error: new Error('旧定位失败'),
      snapshot: await page.evaluate(() => window.__DSH_SNAPSHOT__()),
    });
    if (candidate) candidates.push({ candidate, step });
  }
  expect(candidates.length).toBeGreaterThanOrEqual(4);

  const write = candidates.find(({ step }) => step.riskLevel === 'write')!;
  const skill = oneStepSkill(write.step);
  const directory = await mkdtemp(join(tmpdir(), 'dsh-a6-heal-'));
  const skillPath = join(directory, 'skill.yaml');
  await writeFile(skillPath, `# TODO: A6 原注释\n${stringify(skill)}`, 'utf8');
  let confirmations = 0;
  await expect(executeHeal({
    page, skill, skillPath, candidate: write.candidate, context: execContext(), reason: 'A6 文案变化',
    onConfirm: async () => { confirmations += 1; return true; },
  })).resolves.toMatchObject({ actionVerified: true });
  expect(confirmations).toBe(1);
  expect(parseSkill(await readFile(skillPath, 'utf8')).skill.version).toBe(2);
});

test('A7 Legacy SSR 真实 HTML preflight 提取 __VIEWSTATE 后提交', async ({ page }) => {
  await login(page);
  const context = execContext();
  await executePreflights(page, [{
    name: 'legacyFields', request: { method: 'GET', url: '/legacy/overtime' },
    extract: {
      type: 'regex',
      pattern: 'name="__VIEWSTATE" value="[^"]+"[\\s\\S]*name="__TOKEN" value="[^"]+"',
      group: 0,
    },
  }], context);
  const fields = String(context.vars.legacyFields);
  const viewState = /name="__VIEWSTATE" value="([^"]+)"/.exec(fields)?.[1];
  const token = /name="__TOKEN" value="([^"]+)"/.exec(fields)?.[1];
  expect(viewState).toBeTruthy();
  expect(token).toBeTruthy();
  const response = await page.evaluate(async (vars) => {
    const body = new URLSearchParams({
      __VIEWSTATE: String(vars.__VIEWSTATE), __TOKEN: String(vars.__TOKEN),
      type: 'workday', reason: 'A7 Legacy',
    });
    const result = await fetch('/legacy/overtime/submit', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    return { status: result.status, text: await result.text() };
  }, { __VIEWSTATE: viewState, __TOKEN: token });
  expect(response.status).toBe(200);
  expect(response.text).toContain('提交成功');
});

test.skip('A8 Vue2 条件未启用：doctor 尚未确认目标为 Vue2 + Element UI 2.x', async () => {});

test('A9 自然语言路由抽参后执行已有技能', async ({ browserName }, testInfo) => {
  const instruction = '提交工作日加班，开始 2026-08-19 18:00:00，结束 2026-08-19 21:00:00，事由 A9 验收';
  await runNaturalLanguage(instruction, {
    skills: './skills', profile: testInfo.outputPath(`profile-${browserName}`), llm: true, yes: true,
  }, {
    provider: mockLLM([{
      skillId: 'oa_overtime_submit',
      params: {
        type: '工作日加班', startTime: '2026-08-19 18:00:00',
        endTime: '2026-08-19 21:00:00', reason: 'A9 验收',
      },
      sources: {
        type: '工作日加班', startTime: '2026-08-19 18:00:00',
        endTime: '2026-08-19 21:00:00', reason: 'A9 验收',
      },
    }]),
  });
});

test.skip('A10 Stretch 未启用：不进入开放式探索与固化', async () => {});

test('A11 会话过期只恢复认证，403 直接 forbidden', async ({ page }) => {
  await login(page);
  await page.evaluate(() => fetch('/api/_debug/expire?_nodelay=1', { method: 'POST' }));
  const recovery = recoverAuthentication(page, auth);
  await expect(page.locator('#__dsh_login_hint__')).toBeVisible();
  await page.evaluate(() => fetch('/api/login?_nodelay=1', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'tester' }),
  }));
  await recovery;
  await expect(recoverAuthentication(page, {
    ...auth, sessionApi: '/api/_debug/forbidden?_nodelay=1',
  })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(page.locator('#__dsh_login_hint__')).toHaveCount(0);
});

test('A12 非法 locator/action 被 Schema 护栏拦截并重试', async ({ page }) => {
  await login(page);
  await page.goto('/overtime/apply');
  await page.locator('.el-form-item').first().waitFor();
  await page.locator('.el-form-item__label').filter({ hasText: '事由' }).evaluate((label) => {
    label.textContent = '加班原因';
  });
  const llm = mockLLM([
    { target: { strategy: 'javascript', code: 'submit()' }, evidence: '"加班原因"' },
    { target: { strategy: 'el-form-item', label: '加班原因', kind: 'textarea' }, evidence: '"加班原因"' },
  ]);
  await expect(proposeHeal({
    llm, page,
    step: healStep('a12', 'fill', { strategy: 'el-form-item', label: '事由', kind: 'textarea' }, false),
    error: new Error('定位失败'), snapshot: await page.evaluate(() => window.__DSH_SNAPSHOT__()),
  })).resolves.toMatchObject({ resolveVerified: true });
  expect(() => parseSkill(`skill: { id: bad, name: bad, system: oa, baseUrl: http://oa }
params: []
steps:
  - { id: s1, desc: bad, channel: ui, ui: { action: javascript } }
assertions: []`)).toThrow();
});

function labelVariant(
  page: import('@playwright/test').Page,
  oldLabel: string,
  newLabel: string,
  kind: 'textarea' | 'datepicker' | 'select',
  action: NonNullable<Step['ui']>['action'],
) {
  return {
    old: { strategy: 'el-form-item', label: oldLabel, kind } as LocatorStrategy,
    target: { strategy: 'el-form-item', label: newLabel, kind } as LocatorStrategy,
    action,
    evidence: `"${newLabel}"`,
    mutate: async () => page.locator('.el-form-item__label').filter({ hasText: oldLabel }).evaluate(
      (label, replacement) => { label.textContent = replacement; }, newLabel,
    ),
  };
}

function healStep(
  id: string,
  action: NonNullable<Step['ui']>['action'],
  target: LocatorStrategy,
  write: boolean,
): Step {
  return {
    id, desc: id, channel: 'ui', riskLevel: write ? 'write' : 'read', hasSideEffect: false,
    ui: { action, target, value: action === 'fill' || action === 'setDateTime' || action === 'selectOption' ? 'A6' : undefined },
  };
}

function oneStepSkill(step: Step): Skill {
  return {
    skill: { id: 'a6', name: 'A6', system: 'oa', baseUrl: 'http://127.0.0.1:5173', version: 1 },
    params: [], preflight: [], steps: [step], assertions: [],
  };
}

function execContext(): ExecContext {
  return { params: {}, vars: {}, stepResults: {}, baseUrl: 'http://127.0.0.1:5173' };
}

function mockLLM(responses: object[]): ILLMProvider {
  let index = 0;
  return {
    name: 'mock', supportsVision: false,
    async chat() { return JSON.stringify(responses[index++]!); },
  };
}
