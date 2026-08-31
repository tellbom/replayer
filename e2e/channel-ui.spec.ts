import { expect, test } from '@playwright/test';
import { SkillVerificationSchema } from '@dsh/core';
import type { Skill } from '@dsh/core';

import { replay } from '../packages/replayer/src/engine';
import { oaEntry, seedProfile } from './fixture';

test('channel-ui: force channel ui completes an overtime submission', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`ui-${browserName}-profile`);
  await seedProfile(profileDir);

  const result = await replay(overtimeUiSkill(), {
    params: {
      type: '工作日加班',
      startTime: '2026-08-18 18:00:00',
      endTime: '2026-08-18 21:00:00',
      reason: 'UI 通道验收',
    },
    profileDir,
    entry: oaEntry,
    forceChannel: 'ui',
    noLLM: true,
    onConfirm: async () => true,
  });

  expect(result.ok).toBe(true);
  expect(result.steps).toHaveLength(11);
  expect(result.steps.every((step) => step.channelUsed === 'ui')).toBe(true);
  const debugText = JSON.parse(result.steps.at(-1)?.raw?.text ?? '{}') as { value?: string };
  const debugResult = JSON.parse(debugText.value ?? '{}') as {
    count: number;
    list: Array<{ reason: string }>;
  };
  expect(debugResult.count).toBe(1);
  expect(debugResult.list).toContainEqual(expect.objectContaining({ reason: 'UI 通道验收' }));
});

function overtimeUiSkill(): Skill {
  const baseUrl = 'http://127.0.0.1:15173';
  return {
    skill: {
      id: 'ui_overtime_submit',
      name: 'UI overtime submit',
      system: 'mock-oa',
      baseUrl,
      entry: 'oa',
      version: 1,
    },
    params: [
      {
        name: 'type',
        type: 'enum',
        values: [
          { label: '工作日加班', value: 'workday' },
          { label: '周末加班', value: 'weekend' },
        ],
        required: true,
      },
      { name: 'startTime', type: 'datetime', required: true },
      { name: 'endTime', type: 'datetime', required: true },
      { name: 'reason', type: 'string', required: true },
    ],
    preflight: [],
    steps: [
      uiStep('navigate', 'open overtime form', {
        action: 'click',
        target: { strategy: 'text', text: '加班申请' },
        waitFor: { selector: '.el-select' },
      }),
      uiStep('type', 'select overtime type', {
        action: 'selectOption',
        label: '加班类型',
        value: '{{type}}',
        preAction: { action: 'waitFor', waitFor: { selector: '.el-select' } },
      }),
      uiStep('approver', 'wait for approver', {
        action: 'waitFor',
        waitFor: {
          selector: '.el-form-item:nth-child(5) input',
          notEmpty: true,
          timeoutMs: 3_000,
        },
      }),
      uiStep('start', 'set start time', {
        action: 'setDateTime',
        label: '开始时间',
        value: '{{startTime}}',
      }),
      uiStep('end', 'set end time', {
        action: 'setDateTime',
        label: '结束时间',
        value: '{{endTime}}',
      }),
      uiStep('reason', 'fill reason', {
        action: 'fill',
        label: '事由',
        kind: 'textarea',
        value: '{{reason}}',
      }),
      uiStep('open-confirm', 'open confirmation', {
        action: 'click',
        target: { strategy: 'role', role: 'button', name: '提交' },
        waitFor: { selector: '.el-dialog' },
      }),
      uiStep('confirm', 'confirm submission', {
        action: 'click',
        target: {
          strategy: 'role',
          role: 'button',
          name: '确认提交',
        },
        waitFor: { selector: '.el-message--success' },
      }),
      uiStep('read-result', 'read success message', {
        action: 'readValue',
        target: { strategy: 'css', selector: '.el-message--success' },
        extract: { message: 'textContent' },
      }),
      uiStep('debug', 'open session submissions', {
        action: 'navigate',
        url: `${baseUrl}/api/_debug/submissions`,
        waitFor: { selector: 'body', notEmpty: true },
      }),
      uiStep('read-debug', 'read session submissions', {
        action: 'readValue',
        target: { strategy: 'css', selector: 'body' },
      }),
    ],
    assertions: [],
    verification: SkillVerificationSchema.parse({}),
  };
}

function uiStep(id: string, desc: string, ui: NonNullable<Skill['steps'][number]['ui']>) {
  return {
    id,
    desc,
    channel: 'ui' as const,
    riskLevel: id === 'confirm' ? ('write' as const) : ('read' as const),
    hasSideEffect: id === 'confirm',
    ui,
  };
}
