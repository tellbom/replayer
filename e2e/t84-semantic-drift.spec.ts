import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

import { renderLocatorQualitySummary } from '@dsh/analyzer';
import {
  LocatorNotFoundError,
  SemanticDriftError,
  SkillNeedsRerecordError,
  SkillSchema,
  StepSchema,
  type ExecContext,
  type Skill,
  type Step,
} from '@dsh/core';
import {
  executeUiStep,
  markSkillNeedsRerecord,
  normalizeVisibleText,
  refreshVerification,
  replay,
} from '@dsh/replayer';

import { oaEntry } from './fixture.js';

const hintScript = await readFile('packages/locator/dist/visible-hint.iife.js', 'utf8');

test.beforeEach(async ({ page }) => {
  await page.addScriptTag({ content: hintScript });
});

test('V8-a: nth 漂移到不同语义时硬停且标记 needs_rerecord', async ({ page }) => {
  await page.setContent(`
    <label for="inserted">新增字段</label><input id="inserted">
    <label for="end">结束时间</label><input id="end">
    <button id="submit" onclick="window.submissions++">提交</button>
    <script>window.submissions=0</script>`);
  const step = lowFill('input:nth-of-type(2)', '开始时间');
  const skill = skillWith(step);

  let failure: unknown;
  try {
    await executeUiStep(page, step, context(), []);
  } catch (error) {
    failure = error;
    markSkillNeedsRerecord(skill, step, error);
  }

  expect(failure).toBeInstanceOf(SemanticDriftError);
  expect(await page.locator('#end').inputValue()).toBe('');
  expect(await page.evaluate(() => Reflect.get(window, 'submissions'))).toBe(0);
  expect(skill.verification.status).toBe('needs_rerecord');
  expect(skill.verification.rerecordReason).toMatchObject({ kind: 'semantic-drift', stepId: 'low' });
  expect(skill.verification.rerecordReason?.detail).toContain('开始时间');
  expect(skill.verification.rerecordReason?.detail).toContain('结束时间');
});

test('V8-b: nth 漂移到相同语义继续执行，属于 Accepted product limitation', async ({ page }) => {
  // 语义文本相同时无法区分，属已接受的产品限制。禁止扩展为位置/兄弟/结构自愈。
  await page.setContent(`
    <label for="first">开始时间</label><input id="first">
    <label for="second">开始时间</label><input id="second">`);
  const step = lowFill('input:nth-of-type(2)', '开始时间');
  await executeUiStep(page, step, context(), []);
  await expect(page.locator('#second')).toHaveValue('2026-08-21 09:00:00');
});

test('V9/V12/V13/V16: 同源语义、null 跳过与 HIGH 不误停', async ({ page }) => {
  await page.setContent('<label for="reason">事由：</label><input id="reason">');
  const extractedAtRecord = await page.locator('#reason').evaluate(
    (element) => window.__DSH_EXTRACT_RECORDED_HINT__(element, 'fill', 1),
  );
  const extractedAtReplay = await page.locator('#reason').evaluate(
    (element) => window.__DSH_EXTRACT_RECORDED_HINT__(element, 'fill', 1),
  );
  expect(extractedAtReplay).toEqual(extractedAtRecord);

  await executeUiStep(page, lowFill('#reason', extractedAtRecord.visibleText), context(), []);
  await executeUiStep(page, lowFill('#reason', null), context(), []);

  const high = StepSchema.parse({
    ...lowFill('#reason', '完全不同'),
    id: 'high',
    ui: {
      ...lowFill('#reason', '完全不同').ui,
      target: { strategy: 'playwright', selector: '#reason', confidence: 'HIGH' },
    },
  });
  await executeUiStep(page, high, context(), []);
});

test('V10/V11: 归一化只消除规定差异', () => {
  expect(normalizeVisibleText('事由：')).toBe(normalizeVisibleText('事由 *'));
  expect(normalizeVisibleText('开始时间')).toBe(normalizeVisibleText('开始 时间'));
  expect(normalizeVisibleText('Start Time')).toBe(normalizeVisibleText('start   time'));
  expect(normalizeVisibleText('开始时间')).not.toBe(normalizeVisibleText('结束时间'));
});

test('V14/V15: verified TTL 到期回落 draft，needs_rerecord 启动浏览器前拒绝', async () => {
  const ttlSkill = skillWith(lowFill('#field', '字段'));
  ttlSkill.verification = {
    status: 'verified', requiresFirstRunVerification: false,
    verifiedAt: '2026-07-20T00:00:00.000Z', verifiedRunId: 'run-1', verifiedBy: null,
    verifiedTtlDays: 30, rerecordReason: null,
  };
  refreshVerification(ttlSkill, new Date('2026-08-21T00:00:00.000Z'));
  expect(ttlSkill.verification.status).toBe('draft');
  expect(ttlSkill.verification.requiresFirstRunVerification).toBe(true);

  ttlSkill.verification.status = 'needs_rerecord';
  ttlSkill.verification.rerecordReason = {
    at: '2026-08-21T00:00:00.000Z', stepId: 'low', kind: 'semantic-drift', detail: '字段已变化',
  };
  await expect(replay(ttlSkill, {
    params: {}, profileDir: 'tmp/t84-browser-must-not-start', entry: oaEntry,
  })).rejects.toBeInstanceOf(SkillNeedsRerecordError);
});

test('V6/V7/V17: 结构失败分类与 LOW 高占比告警', () => {
  const step = lowFill('#field', null);
  const skill = skillWith(step);
  markSkillNeedsRerecord(skill, step, new LocatorNotFoundError('目标必须唯一命中，实际 0'));
  expect(skill.verification.rerecordReason?.kind).toBe('not-found');
  skill.verification.status = 'draft';
  markSkillNeedsRerecord(skill, step, new LocatorNotFoundError('目标必须唯一命中，实际 2'));
  expect(skill.verification.rerecordReason?.kind).toBe('strict-multiple');

  const summary = renderLocatorQualitySummary(skill);
  expect(summary).toContain('位置型定位：1  (100%)');
  expect(summary).toContain('其中无法校验：1');
  expect(summary).toContain('Skill 稳定性较低');
});

function lowFill(selector: string, visibleText: string | null): Step {
  return StepSchema.parse({
    id: 'low', desc: '填写', channel: 'ui',
    ui: {
      action: 'fill', value: '2026-08-21 09:00:00',
      target: { strategy: 'playwright', selector, confidence: 'LOW' },
      recordedHint: {
        action: 'fill', visibleText,
        visibleTextSource: visibleText === null ? 'none' : 'accessible-name',
        tagName: 'input', role: 'textbox', matchCountAtRecord: 1,
      },
    },
  });
}

function skillWith(step: Step): Skill {
  return SkillSchema.parse({
    skill: { id: 't84', name: 'T84', system: 'test', baseUrl: 'http://test', entry: 'oa' },
    params: [], steps: [step],
    verification: { status: 'draft', requiresFirstRunVerification: true },
  });
}

function context(): ExecContext {
  return {
    params: {}, vars: {}, stepResults: {}, baseUrl: 'http://test',
    entry: oaEntry, identityDigest: 'tester', scopes: {},
  };
}
