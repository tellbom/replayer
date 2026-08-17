import { expect, test } from '@playwright/test';
import { parseSkill } from '@dsh/core';
import type { ExecContext, HealCandidate, Skill, Step } from '@dsh/core';
import { executeHeal } from '@dsh/llm';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { login } from './helpers';

const locatorScript = await readFile('packages/locator/dist/el-locator.iife.js', 'utf8');

test.beforeEach(async ({ page }) => {
  await page.addInitScript({ content: locatorScript });
  await login(page);
  await page.goto('/overtime/apply');
});

test('heal-execute: read/fill 修复成功后写回且 YAML 可解析', async ({ page }) => {
  await renameReason(page);
  const skill = makeSkill({
    id: 'reason', desc: '填写事由', channel: 'ui', riskLevel: 'read', hasSideEffect: false,
    ui: {
      action: 'fill',
      target: { strategy: 'el-form-item', label: '事由', kind: 'textarea' },
      value: '版本上线',
    },
  });
  const { path } = await skillFile(skill);
  const candidate = healCandidate('reason',
    { strategy: 'el-form-item', label: '事由', kind: 'textarea' },
    { strategy: 'el-form-item', label: '加班原因', kind: 'textarea' }, false);

  await expect(executeHeal({
    page, skill, skillPath: path, candidate, context: context(), reason: '字段改名',
  })).resolves.toMatchObject({ actionVerified: true });
  await expect(page.locator('textarea')).toHaveValue('版本上线');
  const updated = parseSkill(await readFile(path, 'utf8'));
  expect(updated.skill.version).toBe(2);
  expect(updated.steps[0]?.ui?.target).toEqual(candidate.newTarget);
});

test('heal-execute: 写操作拒绝确认时文件完全不变', async ({ page }) => {
  await renameSubmit(page);
  const skill = writeSkill();
  const { path, source } = await skillFile(skill);
  let confirmations = 0;
  const result = await executeHeal({
    page,
    skill,
    skillPath: path,
    candidate: healCandidate('submit', { strategy: 'text', text: '提交' }, { strategy: 'text', text: '发送申请' }, true),
    context: context(),
    reason: '按钮改名',
    onConfirm: async () => { confirmations += 1; return false; },
  });

  expect(result).toBeNull();
  expect(confirmations).toBe(1);
  expect(await readFile(path, 'utf8')).toBe(source);
});

test('heal-execute: postcondition 失败时文件完全不变', async ({ page }) => {
  await renameSubmit(page);
  const skill = writeSkill();
  skill.postcondition = {
    request: { method: 'GET', url: '/api/_debug/submissions' },
    match: { jsonPath: '$.list[*]', where: { reason: '绝不匹配' } },
    expectFound: true,
    timeoutMs: 1,
  };
  const { path, source } = await skillFile(skill);
  const result = await executeHeal({
    page,
    skill,
    skillPath: path,
    candidate: healCandidate('submit', { strategy: 'text', text: '提交' }, { strategy: 'text', text: '发送申请' }, true),
    context: context(),
    reason: '按钮改名',
    onConfirm: async () => true,
  });

  expect(result).toBeNull();
  expect(await readFile(path, 'utf8')).toBe(source);
});

function makeSkill(step: Step): Skill {
  return {
    skill: { id: 'heal-demo', name: 'heal demo', system: 'oa', baseUrl: 'http://127.0.0.1:5173', version: 1 },
    params: [], preflight: [], steps: [step], assertions: [],
  };
}

function writeSkill(): Skill {
  return makeSkill({
    id: 'submit', desc: '提交加班申请', channel: 'ui', riskLevel: 'write', hasSideEffect: true,
    ui: { action: 'click', target: { strategy: 'text', text: '提交' } },
  });
}

function healCandidate(
  stepId: string,
  oldTarget: HealCandidate['oldTarget'],
  newTarget: HealCandidate['newTarget'],
  requiresConfirm: boolean,
): HealCandidate {
  return {
    stepId, oldTarget, newTarget, requiresConfirm,
    resolveVerified: true, actionVerified: false, model: 'mock-healer',
  };
}

function context(): ExecContext {
  return { params: {}, vars: {}, stepResults: {}, baseUrl: 'http://127.0.0.1:5173' };
}

async function skillFile(skill: Skill): Promise<{ path: string; source: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-heal-execute-'));
  const path = join(directory, 'skill.yaml');
  const source = `# TODO: 原始注释\n${stringify(skill)}`;
  await writeFile(path, source, 'utf8');
  return { path, source };
}

async function renameReason(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.el-form-item__label').filter({ hasText: '事由' }).evaluate((label) => {
    label.textContent = '加班原因';
  });
}

async function renameSubmit(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: '提交', exact: true }).evaluate((button) => {
    button.textContent = '发送申请';
  });
}
