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

test('V97-1/V97-2: standard control semantics are recorded without framework knowledge', async ({ page }) => {
  await page.setContent(`
    <fieldset><legend>Priority</legend>
      <input id="urgent" type="radio" name="urgency" value="URGENT"><span>Urgent</span>
    </fieldset>`);
  const hint = await page.locator('#urgent').evaluate(
    (element) => window.__DSH_EXTRACT_RECORDED_HINT__(element, 'check', 1),
  );
  expect(hint.visibleTextSource).toMatch(/^(control-semantics|adjacent-text)$/);
  expect(hint.controlSemantics).toEqual({
    tagName: 'input', type: 'radio', name: 'urgency', value: 'URGENT', checked: false,
  });
});

test('V97-3/V97-4: radio semantic drift stops before any side effect', async ({ page }) => {
  await page.setContent(`
    <input type="radio" name="urgency" value="INSERTED">
    <input id="normal" type="radio" name="urgency" value="NORMAL"
      onclick="window.records.push(this.value)">
    <script>window.records=[]</script>`);
  const step = lowCheck('input[type=radio]:nth-of-type(2)', 'URGENT', 'radio');

  await expect(executeUiStep(page, step, context(), [])).rejects.toBeInstanceOf(SemanticDriftError);
  expect(await page.evaluate(() => Reflect.get(window, 'records'))).toEqual([]);
  await expect(page.locator('#normal')).not.toBeChecked();
});

test('V97-5/V97-6: checkbox and native select drift are blocked', async ({ page }) => {
  await page.setContent(`
    <input id="flag" type="checkbox" name="flag" value="NEW">
    <select id="level" name="level"><option value="NORMAL" selected>Normal</option></select>`);
  await expect(
    executeUiStep(page, lowCheck('#flag', 'ORIGINAL', 'checkbox'), context(), []),
  ).rejects.toBeInstanceOf(SemanticDriftError);
  await expect(
    executeUiStep(page, lowSelect('#level', 'URGENT'), context(), []),
  ).rejects.toBeInstanceOf(SemanticDriftError);
  await expect(page.locator('#flag')).not.toBeChecked();
  await expect(page.locator('#level')).toHaveValue('NORMAL');
});

test('V97-7/V97-8: matching LOW controls pass repeatedly and HIGH remains exempt', async ({ page }) => {
  await page.setContent('<input id="urgent" type="radio" name="urgency" value="URGENT">');
  for (let index = 0; index < 10; index += 1) {
    await page.locator('#urgent').uncheck().catch(() => undefined);
    await executeUiStep(page, lowCheck('#urgent', 'URGENT', 'radio'), context(), []);
  }
  const high = lowCheck('#urgent', 'DIFFERENT', 'radio');
  high.ui!.target = { strategy: 'playwright', selector: '#urgent', confidence: 'HIGH' };
  await executeUiStep(page, high, context(), []);
});

test('V98-2: unverifiable LOW target can be stopped before the action', async ({ page }) => {
  await page.setContent('<button id="anonymous" onclick="window.clicked=true"></button>');
  const step = StepSchema.parse({
    id: 'anonymous', desc: 'anonymous click', channel: 'ui',
    ui: {
      action: 'click',
      target: { strategy: 'playwright', selector: '#anonymous', confidence: 'LOW' },
      recordedHint: {
        action: 'click', visibleText: null, visibleTextSource: 'none', controlSemantics: null,
        tagName: 'button', role: 'button', matchCountAtRecord: 1,
      },
    },
  });
  let observed: unknown;
  const result = await executeUiStep(page, step, context(), [], {
    onLowTarget: async (inspection) => {
      observed = inspection;
      return false;
    },
  });

  expect(result).toMatchObject({ ok: false, outcome: 'not_sent' });
  expect(observed).toEqual(expect.objectContaining({
    unverifiable: true,
    element: expect.objectContaining({ tagName: 'button' }),
  }));
  expect(await page.evaluate(() => Reflect.get(window, 'clicked'))).not.toBe(true);
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
        controlSemantics: null,
        tagName: 'input', role: 'textbox', matchCountAtRecord: 1,
      },
    },
  });
}

function lowCheck(selector: string, value: string, type: 'radio' | 'checkbox'): Step {
  return StepSchema.parse({
    id: `low-${type}`, desc: 'check control', channel: 'ui',
    ui: {
      action: 'check', checked: true,
      target: { strategy: 'playwright', selector, confidence: 'LOW' },
      recordedHint: {
        action: 'check', visibleText: `urgency = ${value}`,
        visibleTextSource: 'control-semantics',
        controlSemantics: {
          tagName: 'input', type, name: type === 'radio' ? 'urgency' : 'flag', value, checked: false,
        },
        tagName: 'input', role: type, matchCountAtRecord: 1,
      },
    },
  });
}

function lowSelect(selector: string, value: string): Step {
  return StepSchema.parse({
    id: 'low-select', desc: 'select control', channel: 'ui',
    ui: {
      action: 'selectOption', value,
      target: { strategy: 'playwright', selector, confidence: 'LOW' },
      recordedHint: {
        action: 'select', visibleText: `level = ${value}`,
        visibleTextSource: 'control-semantics',
        controlSemantics: {
          tagName: 'select', type: 'select-one', name: 'level', value, checked: null,
        },
        tagName: 'select', role: 'combobox', matchCountAtRecord: 1,
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
