import { expect, test } from '@playwright/test';
import { parseSkill } from '@dsh/core';
import { replay } from '@dsh/replayer';
import { readFile } from 'node:fs/promises';

import { login } from '../helpers';

test('A3 rebuild 后 CSS hash 变化但语义技能仍可回放', async ({ page, browserName }, testInfo) => {
  const expectedClass = process.env.A3_EXPECTED_CLASS;
  if (!expectedClass) throw new Error('A3_EXPECTED_CLASS 未设置');
  await login(page);
  await page.goto('/overtime/apply');
  const currentClass = await page.getByRole('button', { name: '提交', exact: true }).getAttribute('class');
  expect(currentClass).toContain(expectedClass);

  const skill = parseSkill(await readFile('skills/oa_overtime_submit.yaml', 'utf8'));
  const result = await replay(skill, {
    params: {
      type: '工作日加班',
      startTime: '2026-08-19 18:00:00',
      endTime: '2026-08-19 21:00:00',
      reason: `A3-rebuild-${process.env.A3_ROUND ?? '0'}`,
    },
    profileDir: testInfo.outputPath(`profile-${browserName}`),
    noLLM: true,
    onConfirm: async () => true,
  });
  expect(result.ok).toBe(true);
  expect(result.steps.find((step) => step.stepId === 'submit')?.ok).toBe(true);
});
