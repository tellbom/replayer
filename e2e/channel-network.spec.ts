import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { ExecContext, ParamDefinition, Step } from '@dsh/core';

import { executeNetworkStep } from '../packages/replayer/src/channel-network';
import { login } from './helpers';
import { oaEntry } from './fixture';

const params: ParamDefinition[] = [
  {
    name: 'type',
    type: 'enum',
    values: [
      { label: '工作日加班', value: 'workday' },
      { label: '周末加班', value: 'weekend' },
    ],
    required: true,
  },
  { name: 'reason', type: 'string', required: true },
];

test('channel-network: 联动提交、模板缺失与响应丢失机械分类', async ({ page }) => {
  await login(page);
  const csrf = await page.locator('meta[name="csrf-token"]').getAttribute('content');
  const context: ExecContext = {
    params: {
      type: '工作日加班',
      reason: '网络通道验证',
      items: [{ page: 1 }, { page: 2 }],
    },
    vars: { csrf },
    stepResults: {},
    baseUrl: 'http://127.0.0.1:15173',
    entry: oaEntry,
    identityDigest: 'tester',
    scopes: {},
  };
  const approver = approverStep('s1');
  const submit = submitStep('s2', '/api/overtime/submit');

  const loopResult = await executeNetworkStep(
    page,
    {
      id: 'loop',
      desc: '数组展开',
      channel: 'network',
      riskLevel: 'read',
      hasSideEffect: false,
      network: {
        method: 'GET',
        url: '/api/overtime/history?page={{items[i].page}}',
        contentType: 'json',
      },
    },
    context,
    params,
  );
  expect(loopResult.outcome).toBe('confirmed_success');
  expect(context.stepResults.loop).toEqual([{}, {}]);

  const approverResult = await executeNetworkStep(page, approver, context, params);
  const submitResult = await executeNetworkStep(page, submit, context, params);
  expect(approverResult.outcome).toBe('confirmed_success');
  expect(context.stepResults.s1).toEqual(
    expect.objectContaining({ approverId: 1023, approvalToken: expect.any(String) }),
  );
  expect(submitResult.outcome).toBe('confirmed_success');

  const missing = await executeNetworkStep(
    page,
    {
      ...submit,
      id: 'missing',
      network: { ...submit.network!, body: { reason: '{{missing}}' } },
    },
    context,
    params,
  );
  expect(missing.outcome).toBe('not_sent');

  await executeNetworkStep(page, approverStep('s3'), context, params);
  const before = await submissionCount(page);
  const dropped = await executeNetworkStep(
    page,
    submitStep('s4', '/api/overtime/submit?drop_response=1'),
    context,
    params,
  );
  expect(dropped.outcome).toBe('outcome_unknown');
  await expect.poll(() => submissionCount(page)).toBe(before + 1);
});

function approverStep(id: string): Step {
  return {
    id,
    desc: '获取审批人',
    channel: 'network',
    riskLevel: 'write',
    hasSideEffect: true,
    network: {
      method: 'POST',
      url: '/api/overtime/approver',
      contentType: 'json',
      body: { type: '{{type|enumValue}}' },
      extract: { approverId: '$.approverId', approvalToken: '$.approvalToken' },
    },
  };
}

function submitStep(id: string, url: string): Step {
  const source = id === 's2' ? 's1' : 's3';
  return {
    id,
    desc: '提交加班',
    channel: 'network',
    riskLevel: 'write',
    hasSideEffect: true,
    network: {
      method: 'POST',
      url,
      headers: { 'x-csrf-token': '{{csrf}}' },
      contentType: 'json',
      body: {
        type: '{{type|enumValue}}',
        startTime: '2026-08-18 18:00:00',
        endTime: '2026-08-18 21:00:00',
        reason: '{{reason}}',
        approverId: `{{${source}.approverId}}`,
        approvalToken: `{{${source}.approvalToken}}`,
      },
    },
  };
}

async function submissionCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch('/api/_debug/submissions', { credentials: 'include' });
    return ((await response.json()) as { count: number }).count;
  });
}
