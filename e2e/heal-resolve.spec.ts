import { expect, test } from '@playwright/test';
import type { ILLMProvider, Step } from '@dsh/core';
import { proposeHeal } from '@dsh/llm';
import { readFile } from 'node:fs/promises';

import { login } from './helpers';

const snapshotScript = await readFile('packages/locator/dist/snapshot.iife.js', 'utf8');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: snapshotScript });
  await login(page);
  await page.goto('/overtime/apply');
});

test('heal-resolve: 字段改名后生成仅定位验证的 candidate', async ({ page }) => {
  await page.locator('.el-form-item__label').filter({ hasText: '事由' }).evaluate((label) => {
    label.textContent = '加班原因';
  });
  const snapshot = await page.evaluate(() => window.__DSH_SNAPSHOT__());
  const candidate = await proposeHeal({
    llm: mockLLM({
      target: { strategy: 'el-form-item', label: '加班原因', kind: 'textarea' },
      evidence: 'textarea "加班原因"',
    }),
    page,
    step: step('reason', '填写事由', 'read', false, {
      action: 'fill',
      target: { strategy: 'el-form-item', label: '事由', kind: 'textarea' },
      value: '版本上线',
    }),
    error: new Error('找不到表单项: 事由'),
    snapshot,
  });

  expect(candidate).toMatchObject({ resolveVerified: true, actionVerified: false, requiresConfirm: false });
});

test('heal-resolve: 写按钮改名只验证定位且不产生提交', async ({ page }) => {
  await page.getByRole('button', { name: '提交', exact: true }).evaluate((button) => {
    button.textContent = '发送申请';
  });
  const before = await submissionCount(page);
  const snapshot = await page.evaluate(() => window.__DSH_SNAPSHOT__());
  const candidate = await proposeHeal({
    llm: mockLLM({ target: { strategy: 'text', text: '发送申请' }, evidence: 'button   "发送申请"' }),
    page,
    step: step('submit', '提交加班申请', 'write', true, {
      action: 'click',
      target: { strategy: 'text', text: '提交' },
    }),
    error: new Error('找不到文本: 提交'),
    snapshot,
  });

  expect(candidate).toMatchObject({ resolveVerified: true, actionVerified: false, requiresConfirm: true });
  expect(await submissionCount(page)).toBe(before);
});

function mockLLM(response: object): ILLMProvider {
  return {
    name: 'mock-healer',
    supportsVision: false,
    async chat() { return JSON.stringify(response); },
  };
}

function step(
  id: string,
  desc: string,
  riskLevel: Step['riskLevel'],
  hasSideEffect: boolean,
  ui: NonNullable<Step['ui']>,
): Step {
  return { id, desc, channel: 'ui', riskLevel, hasSideEffect, ui };
}

async function submissionCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch('/api/_debug/submissions');
    return (await response.json() as { count: number }).count;
  });
}
