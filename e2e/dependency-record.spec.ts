import { expect, test } from '@playwright/test';
import type { RecordSession } from '@dsh/core';

import { correlate } from '../packages/analyzer/src/correlate';
import { login } from './helpers';

test('dependency-record: 切换类型后必须重新注入审批人与 token', async ({ page }) => {
  const token = '<REDACTED:sha256:123456789abc>';
  const recorded = recording(token);
  const submit = correlate(recorded)
    .flatMap((step) => step.requests)
    .find((request) => request.requestId === 'submit');
  const dependencies = submit?.dependsOn ?? [];
  expect(dependencies).toEqual(
    expect.arrayContaining([
      { from: 'approver', path: '$.approverId', to: 'body.approverId' },
      { from: 'approver', path: '$.approvalToken', to: 'body.approvalToken' },
    ]),
  );

  await login(page);
  const statuses = await page.evaluate(async (links) => {
    const csrf = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content ?? '';
    const post = (url: string, body: object) =>
      fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        body: JSON.stringify(body),
      });
    const workday = await (await post('/api/overtime/approver', { type: 'workday' })).json();
    const weekend = await (await post('/api/overtime/approver', { type: 'weekend' })).json();
    const common = {
      startTime: '2026-08-22 09:00:00',
      endTime: '2026-08-22 12:00:00',
      reason: '依赖识别反例',
    };
    const oldResponse = await post('/api/overtime/submit', {
      ...common,
      type: 'workday',
      approverId: workday.approverId,
      approvalToken: workday.approvalToken,
    });
    const replayBody: Record<string, unknown> = {
      ...common,
      type: 'weekend',
      approverId: workday.approverId,
      approvalToken: workday.approvalToken,
    };
    for (const link of links) {
      replayBody[link.to.replace(/^body\./, '')] = weekend[link.path.replace(/^\$\./, '')];
    }
    const replayResponse = await post('/api/overtime/submit', replayBody);
    return { old: oldResponse.status, replay: replayResponse.status };
  }, dependencies);

  expect(statuses).toEqual({ old: 400, replay: 200 });
});

function recording(token: string): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://127.0.0.1:5173', userAgent: 'Chrome' },
    actions: [{ ts: 1_000, type: 'select' }, { ts: 2_000, type: 'click' }],
    network: [
      {
        requestId: 'approver',
        requestTs: 1_100,
        responseTs: 1_200,
        method: 'POST',
        url: 'http://127.0.0.1:5173/api/overtime/approver',
        resourceType: 'fetch',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ type: 'workday' }),
        status: 200,
        responseBody: JSON.stringify({ approverId: 1023, approvalToken: token }),
        mutating: true,
        sanitizeMode: 'structured',
      },
      {
        requestId: 'submit',
        requestTs: 2_100,
        responseTs: 2_200,
        method: 'POST',
        url: 'http://127.0.0.1:5173/api/overtime/submit',
        resourceType: 'fetch',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          type: 'workday',
          approverId: 1023,
          approvalToken: token,
        }),
        status: 200,
        responseBody: JSON.stringify({ code: 0 }),
        mutating: true,
        sanitizeMode: 'structured',
      },
    ],
    pages: [],
  };
}
