import { expect, test } from '@playwright/test';
import { ChannelCarrierMissingError, ForbiddenError, SkillVerificationSchema } from '@dsh/core';
import type { Skill, Step, StepResult } from '@dsh/core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { replay } from '../packages/replayer/src/engine';
import { oaEntry, seedProfile } from './fixture';

const baseUrl = 'http://127.0.0.1:15173';
const runParams = {
  type: '工作日加班',
  startTime: '2026-08-18 18:00:00',
  endTime: '2026-08-18 21:00:00',
  reason: '安全降级验收',
};

test('Phase 0: UI fallback accepts values retained in live IDL properties', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`not-sent-${browserName}-profile`);
  await seedProfile(profileDir);
  let confirmations = 0;
  const skill = makeSkill('fallback-not-sent', [
    ...loginAndOpenSteps(),
    {
      id: 'merged-reason',
      desc: 'merge reason',
      channel: 'merged',
      riskLevel: 'read',
      hasSideEffect: false,
      ui: { action: 'fill', value: '{{reason}}' },
    },
    fallbackSubmitStep('http://['),
    debugStep(),
  ]);
  const type = skill.params.find((param) => param.name === 'type')!;
  type.carrier = {
    via: 'ui-select', targetLocator: { strategy: 'label', label: '加班类型', kind: 'select' },
  };
  const startTime = skill.params.find((param) => param.name === 'startTime')!;
  startTime.carrier = {
    via: 'ui-fill', targetLocator: { strategy: 'label', label: '开始时间', kind: 'datepicker' },
  };
  const endTime = skill.params.find((param) => param.name === 'endTime')!;
  endTime.carrier = {
    via: 'ui-fill', targetLocator: { strategy: 'label', label: '结束时间', kind: 'datepicker' },
  };
  const reason = skill.params.find((param) => param.name === 'reason')!;
  reason.carrier = { via: 'network-body', requestStepId: 'submit' };
  reason.recoveryCarrier = {
    via: 'ui-fill',
    targetLocator: { strategy: 'label', label: '事由', kind: 'textarea' },
  };
  const result = await replay(skill, {
    params: runParams,
    profileDir,
    entry: oaEntry,
    noLLM: true,
    onConfirm: async () => {
      confirmations += 1;
      return true;
    },
  });

  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(result.extracted['merged-reason']).toBe(runParams.reason);
  expect(result.steps.find((step) => step.stepId === 'submit')).toMatchObject({
    channelUsed: 'ui',
    outcome: 'confirmed_success',
  });
  expect(confirmations).toBe(2);
  expect(result.steps.some((step) => step.stepId === 'debug')).toBe(true);
});

test('Phase 0 [long-term]: merged dependency blocks a not_sent network step from falling back to UI', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`carrier-${browserName}-profile`);
  await seedProfile(profileDir);
  const submit = fallbackSubmitStep('http://[');
  submit.network!.body = { reason: '{{merged-reason}}' };
  const skill = makeSkill('phase0-carrier-gate', [
    ...loginAndOpenSteps(),
    {
      id: 'merged-reason', desc: 'merge reason', channel: 'merged',
      riskLevel: 'read', hasSideEffect: false,
      ui: { action: 'fill', value: '{{reason}}' },
    },
    submit,
  ]);
  let confirmations = 0;

  await expect(replay(skill, {
    params: runParams, profileDir, entry: oaEntry, noLLM: true,
    onConfirm: async () => { confirmations += 1; return true; },
  })).rejects.toBeInstanceOf(ChannelCarrierMissingError);
  expect(confirmations).toBe(1);
});

test('fallback: drop_response resolves by postcondition without replay', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`drop-${browserName}-profile`);
  await seedProfile(profileDir);
  const skill = makeSkill(
    'fallback-outcome-unknown',
    [
      ...loginSteps(),
      {
        id: 'csrf',
        desc: 'get csrf',
        channel: 'network',
        riskLevel: 'read',
        hasSideEffect: false,
        network: {
          method: 'GET',
          url: '/api/csrf',
          contentType: 'json',
          extract: { csrfToken: '$.token' },
        },
      },
      approverStep(),
      dropSubmitStep(),
      debugStep(),
    ],
    {
      request: { method: 'GET', url: '/api/overtime/history?limit=5&order=desc' },
      match: {
        jsonPath: '$.list[*]',
        where: { reason: '{{reason}}', startTime: '{{startTime}}' },
        limit: 5,
      },
      expectFound: true,
      timeoutMs: 3_000,
    },
  );
  const result = await replay(skill, {
    params: runParams,
    profileDir,
    entry: oaEntry,
    noLLM: true,
    onConfirm: async () => true,
  });

  const submit = result.steps.find((step) => step.stepId === 'submit');
  expect(submit).toMatchObject({
    ok: true,
    outcome: 'confirmed_success',
    outcomeResolvedBy: 'postcondition',
    postconditionResult: { found: true, expectFound: true },
  });
  expect(debugCount(result.steps.at(-1))).toBe(1);
});

test('fallback: 403 is forbidden and never enters authentication recovery', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`forbidden-${browserName}-profile`);
  await seedProfile(profileDir);
  const skill = makeSkill('fallback-forbidden', [
    ...loginSteps(),
    {
      id: 'forbidden',
      desc: 'forbidden request',
      channel: 'network',
      riskLevel: 'read',
      hasSideEffect: false,
      network: { method: 'GET', url: '/api/_debug/forbidden', contentType: 'json' },
    },
  ]);
  let failure: (ForbiddenError & { diagnosticDir?: string }) | undefined;
  try {
    await replay(skill, {
      params: runParams,
      profileDir,
      entry: oaEntry,
      noLLM: true,
    });
  } catch (error) {
    failure = error as ForbiddenError & { diagnosticDir?: string };
  }
  expect(failure).toBeInstanceOf(ForbiddenError);
  expect(failure?.diagnosticDir).toBeTruthy();
  const dom = await readFile(join(failure!.diagnosticDir!, 'step-forbidden-dom.html'), 'utf8');
  expect(dom).not.toContain('__dsh_login_hint__');
});

function makeSkill(id: string, steps: Step[], postcondition?: Skill['postcondition']): Skill {
  return {
    skill: { id, name: id, system: 'mock-oa', baseUrl, entry: 'oa', version: 1 },
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
    steps,
    assertions: [],
    verification: SkillVerificationSchema.parse({}),
    ...(postcondition ? { postcondition } : {}),
  };
}

function loginSteps(): Step[] {
  return [];
}

function loginAndOpenSteps(): Step[] {
  return [
    ...loginSteps(),
    uiStep('open-overtime', {
      action: 'click',
      target: { strategy: 'text', text: '加班申请' },
      waitFor: { selector: '.el-select' },
    }),
  ];
}

function uiStep(id: string, ui: NonNullable<Step['ui']>): Step {
  return {
    id,
    desc: id,
    channel: 'ui',
    riskLevel: 'read',
    hasSideEffect: false,
    ui,
  };
}

function fallbackSubmitStep(url: string): Step {
  return {
    id: 'submit',
    desc: 'submit with safe fallback',
    channel: 'auto',
    riskLevel: 'write',
    hasSideEffect: true,
    network: { method: 'POST', url, contentType: 'json', body: { reason: '{{reason}}' } },
    ui: {
      action: 'click',
      target: {
        strategy: 'el-dialog-scoped',
        dialogTitle: '确认提交',
        inner: { strategy: 'text', text: '确认提交', nth: 1 },
      },
      waitFor: { selector: '.el-message--success' },
      preAction: {
        action: 'click',
        target: { strategy: 'role', role: 'button', name: '提交' },
        waitFor: { selector: '.el-dialog' },
        preAction: {
          action: 'fill',
          label: '事由',
          kind: 'textarea',
          value: '{{reason}}',
          preAction: {
            action: 'setDateTime',
            label: '结束时间',
            value: '{{endTime}}',
            preAction: {
              action: 'setDateTime',
              label: '开始时间',
              value: '{{startTime}}',
              preAction: {
                action: 'waitFor',
                waitFor: {
                  selector: '.el-form-item:nth-child(5) input',
                  notEmpty: true,
                  timeoutMs: 3_000,
                },
                preAction: {
                  action: 'selectOption',
                  label: '加班类型',
                  value: '{{type}}',
                },
              },
            },
          },
        },
      },
    },
  };
}

function approverStep(): Step {
  return {
    id: 'approver',
    desc: 'get approver',
    channel: 'network',
    riskLevel: 'read',
    hasSideEffect: false,
    network: {
      method: 'POST',
      url: '/api/overtime/approver',
      contentType: 'json',
      body: { type: '{{type|enumValue}}' },
      extract: { approverId: '$.approverId', approvalToken: '$.approvalToken' },
    },
  };
}

function dropSubmitStep(): Step {
  return {
    id: 'submit',
    desc: 'drop submit response',
    channel: 'network',
    riskLevel: 'write',
    hasSideEffect: true,
    network: {
      method: 'POST',
      url: '/api/overtime/submit?drop_response=1',
      headers: { 'x-csrf-token': '{{csrf.csrfToken}}' },
      contentType: 'json',
      body: {
        type: '{{type|enumValue}}',
        startTime: '{{startTime}}',
        endTime: '{{endTime}}',
        reason: '{{reason}}',
        approverId: '{{approver.approverId}}',
        approvalToken: '{{approver.approvalToken}}',
      },
    },
  };
}

function debugStep(): Step {
  return {
    id: 'debug',
    desc: 'read submissions',
    channel: 'network',
    riskLevel: 'read',
    hasSideEffect: false,
    network: { method: 'GET', url: '/api/_debug/submissions', contentType: 'json' },
  };
}

function debugCount(result: StepResult | undefined): number {
  return (JSON.parse(result?.raw?.text ?? '{}') as { count?: number }).count ?? -1;
}
