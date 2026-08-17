import type { RecordedRequest, RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { correlate } from './correlate.js';

describe('correlate', () => {
  it('uses requestTs instead of a slow response timestamp', () => {
    const session = baseSession();
    session.actions = [
      { ts: 1_000, type: 'select', label: '加班类型', value: '工作日加班' },
      { ts: 1_500, type: 'fill', label: '事由', value: '版本上线' },
    ];
    session.network = [request('approver', 1_100, 1_800)];

    const result = correlate(session);
    expect(result[0]?.requests.map((item) => item.requestId)).toEqual(['approver']);
    expect(result[1]?.requests).toEqual([]);
  });

  it('assigns the overtime approver request to the select action', () => {
    const session = baseSession();
    session.actions = [
      { ts: 1_000, type: 'navigate', url: 'http://oa/overtime/apply' },
      { ts: 2_000, type: 'select', label: '加班类型', value: '工作日加班' },
      { ts: 2_500, type: 'datetime', label: '开始时间', value: '2026-08-18 18:00:00' },
    ];
    session.network = [request('approver', 2_100, 2_700)];

    const result = correlate(session);
    expect(result[1]?.action?.type).toBe('select');
    expect(result[1]?.requests[0]?.url).toContain('/overtime/approver');
  });

  it('groups requests outside every action window as orphan', () => {
    const session = baseSession();
    session.actions = [{ ts: 5_000, type: 'click' }];
    session.network = [request('page-init', 1_000, 1_200)];

    const result = correlate(session);
    expect(result.at(-1)).toEqual(
      expect.objectContaining({
        id: 'orphan',
        action: null,
        orphan: true,
        requests: [expect.objectContaining({ requestId: 'page-init' })],
      }),
    );
  });

  it('assigns one request to only one action', () => {
    const session = baseSession();
    session.actions = [
      { ts: 1_000, type: 'click' },
      { ts: 1_100, type: 'fill', value: 'x' },
    ];
    session.network = [request('single', 1_100, 1_300)];

    const owners = correlate(session).filter((step) => step.requests.length > 0);
    expect(owners).toHaveLength(1);
    expect(owners[0]?.action?.type).toBe('fill');
  });

  it('detects approverId and approvalToken dependencies and the final submit', () => {
    const token = '<REDACTED:sha256:123456789abc>';
    const session = baseSession();
    session.actions = [{ ts: 1_000, type: 'select' }, { ts: 2_000, type: 'click' }];
    session.network = [
      {
        ...request('approver', 1_100, 1_200),
        responseBody: JSON.stringify({ approverId: 1023, approvalToken: token }),
      },
      {
        ...request('submit', 2_100, 2_200),
        postData: JSON.stringify({
          type: 'workday',
          approverId: 1023,
          approvalToken: token,
        }),
      },
    ];

    const steps = correlate(session);
    const submit = steps.flatMap((step) => step.requests).find((item) => item.requestId === 'submit');
    expect(submit?.dependsOn).toEqual(
      expect.arrayContaining([
        { from: 'approver', path: '$.approverId', to: 'body.approverId' },
        { from: 'approver', path: '$.approvalToken', to: 'body.approvalToken' },
      ]),
    );
    expect(submit?.isSubmit).toBe(true);
    expect(steps[1]?.hasSideEffect).toBe(true);
  });

  it('rejects a dependency discovered from fallback sanitization', () => {
    const session = baseSession();
    session.actions = [{ ts: 1_000, type: 'click' }];
    session.network = [
      { ...request('source', 1_100, 1_200), responseBody: JSON.stringify({ token: 'same' }) },
      {
        ...request('target', 1_300, 1_400),
        postData: JSON.stringify({ token: 'same' }),
        sanitizeMode: 'fallback',
      },
    ];
    expect(() => correlate(session)).toThrow(/structured/);
  });
});

function baseSession(): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome' },
    actions: [],
    network: [],
    pages: [],
  };
}

function request(id: string, requestTs: number, responseTs: number): RecordedRequest {
  return {
    requestId: id,
    requestTs,
    responseTs,
    method: 'POST',
    url: `http://oa/api/overtime/${id}`,
    resourceType: 'fetch',
    headers: { 'content-type': 'application/json' },
    postData: '{}',
    status: 200,
    responseBody: '{}',
    mutating: true,
    sanitizeMode: 'structured',
  };
}
