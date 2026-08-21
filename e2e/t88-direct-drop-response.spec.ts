import { expect, test } from '@playwright/test';
import type { ExecContext, ParamDefinition, Step } from '@dsh/core';

import { executeNetworkStep } from '../packages/replayer/src/channel-network';
import { oaEntry } from './fixture';
import { login } from './helpers';

const backendOrigin = 'http://127.0.0.1:3000';
const params: ParamDefinition[] = [{
  name: 'type', type: 'enum', required: true,
  values: [{ label: '工作日加班', value: 'workday' }],
}];

test('T-88: direct backend disconnect takes status=null and commits exactly once', async ({ page }) => {
  await login(page);
  await page.goto(`${backendOrigin}/api/session?_nodelay=1`);
  const csrf = await page.evaluate(() =>
    fetch('/api/csrf?_nodelay=1', { credentials: 'include' }).then((response) => response.json()),
  ) as { token: string };
  const context: ExecContext = {
    params: { type: '工作日加班' }, vars: { csrf: csrf.token }, stepResults: {},
    baseUrl: backendOrigin, entry: oaEntry, identityDigest: 'tester', scopes: {},
  };

  const approver = await executeNetworkStep(page, approverStep(), context, params);
  expect(approver.outcome).toBe('confirmed_success');
  const before = await submissionCount(page);
  const dropped = await executeNetworkStep(page, submitStep(), context, params);
  const after = await submissionCount(page);

  console.log(`T88_DIRECT=${JSON.stringify({ status: null, branch: dropped.error, delta: after - before })}`);
  expect(dropped).toMatchObject({
    ok: false,
    outcome: 'outcome_unknown',
    channelUsed: 'network',
    error: expect.stringContaining('status=null'),
  });
  expect(after - before).toBe(1);
});

function approverStep(): Step {
  return {
    id: 'approver', desc: 'load approver', channel: 'network', riskLevel: 'write', hasSideEffect: true,
    network: {
      method: 'POST', url: '/api/overtime/approver?_nodelay=1', contentType: 'json',
      body: { type: '{{type|enumValue}}' },
      extract: { approverId: '$.approverId', approvalToken: '$.approvalToken' },
    },
  };
}

function submitStep(): Step {
  return {
    id: 'submit', desc: 'submit overtime', channel: 'network', riskLevel: 'write', hasSideEffect: true,
    network: {
      method: 'POST', url: '/api/overtime/submit?drop_response=1&direct_disconnect=1&_nodelay=1', contentType: 'json',
      headers: { 'x-csrf-token': '{{csrf}}' },
      body: {
        type: '{{type|enumValue}}', startTime: '2026-08-23 09:00:00',
        endTime: '2026-08-23 12:00:00', reason: 'T88 direct disconnect',
        approverId: '{{approver.approverId}}', approvalToken: '{{approver.approvalToken}}',
      },
    },
  };
}

async function submissionCount(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() =>
    fetch('/api/_debug/submissions?_nodelay=1', { credentials: 'include' })
      .then((response) => response.json())
      .then((body: { count: number }) => body.count),
  );
}
