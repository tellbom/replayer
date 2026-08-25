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
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'orphan',
          action: null,
          orphan: true,
          requests: [expect.objectContaining({ requestId: 'page-init' })],
        }),
      ]),
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

  it('ignores repeated weak values but keeps unique ids as dependencies', () => {
    const session = baseSession();
    session.actions = [{ ts: 1_000, type: 'click' }];
    session.network = [
      {
        ...request('serverinfo', 900, 950),
        responseBody: JSON.stringify({ flags: [false, false, false], approverId: 1023, name: '' }),
      },
      {
        ...request('submit', 1_100, 1_200),
        postData: JSON.stringify({ enabled: false, approverId: 1023, name: '' }),
      },
    ];
    const submit = correlate(session)
      .flatMap((step) => step.requests)
      .find((item) => item.requestId === 'submit');
    expect(submit?.dependsOn).toEqual([{ from: 'serverinfo', path: '$.approverId', to: 'body.approverId' }]);
  });

  it('keeps orphan requests in temporal order across action steps', () => {
    const session = baseSession();
    session.actions = [{ ts: 2_000, type: 'click' }];
    session.network = [
      request('orphan-init', 1_000, 1_200),
      request('submit', 2_100, 2_200),
    ];
    const steps = correlate(session);
    // orphan(1_000) 应排在 action(2_000) 之前，否则依赖模板会引用后置步骤
    expect(steps.map((step) => step.id)).toEqual(['orphan', 'action-1']);
    expect(steps[0]?.requests[0]?.requestId).toBe('orphan-init');
  });

  it('rejects a dependency discovered from fallback sanitization', () => {
    const session = baseSession();
    session.actions = [{ ts: 1_000, type: 'click' }];
    const shared = 'same-secret-value';
    session.network = [
      { ...request('source', 1_100, 1_200), responseBody: JSON.stringify({ token: shared }) },
      {
        ...request('target', 1_300, 1_400),
        postData: JSON.stringify({ token: shared }),
        sanitizeMode: 'fallback',
      },
    ];
    expect(() => correlate(session)).toThrow(/structured/);
  });

  it('uses a unique request value match instead of the nearest fast-paced action', () => {
    const session = baseSession();
    session.actions = [
      { ts: 1_000, type: 'select', label: '加班类型', value: '工作日加班' },
      { ts: 1_120, type: 'datetime', label: '开始时间', value: '2026-08-18 18:00:00' },
      { ts: 1_240, type: 'fill', label: '事由', value: '版本上线' },
    ];
    session.network = [
      {
        ...request('types', 900, 950), method: 'GET', postData: null, mutating: false,
        responseBody: JSON.stringify([
          { label: '工作日加班', value: 'workday' },
          { label: '周末加班', value: 'weekend' },
        ]),
      },
      { ...request('approver', 1_505, 1_600), postData: JSON.stringify({ type: 'workday' }) },
    ];

    const owner = correlate(session).find((step) => step.requests.some((item) => item.requestId === 'approver'));
    expect(owner?.action?.type).toBe('select');
    expect(owner?.requests[0]?.correlation).toMatchObject({
      method: 'request-value-match', confidence: 'high', ownerActionIndex: 0,
    });
  });

  it('keeps request value causality when later actions are more than 1.5 seconds apart', () => {
    const session = baseSession();
    session.actions = [
      { ts: 1_000, type: 'select', label: '加班类型', value: '工作日加班' },
      { ts: 3_000, type: 'datetime', label: '开始时间', value: '2026-08-18 18:00:00' },
      { ts: 5_000, type: 'fill', label: '事由', value: '版本上线' },
    ];
    session.network = [
      {
        ...request('types', 900, 950), method: 'GET', postData: null, mutating: false,
        responseBody: JSON.stringify([{ label: '工作日加班', value: 'workday' }]),
      },
      { ...request('approver', 6_700, 6_800), postData: JSON.stringify({ type: 'workday' }) },
    ];

    const owner = correlate(session).find((step) => step.requests.some((item) => item.requestId === 'approver'));
    expect(owner?.action?.type).toBe('select');
    expect(owner?.requests[0]?.correlation?.method).toBe('request-value-match');
  });

  it('marks the time-window fallback as low confidence', () => {
    const session = baseSession();
    session.actions = [{ ts: 1_000, type: 'click', text: '刷新' }];
    session.network = [{ ...request('telemetry', 1_137, 1_200), postData: '{}' }];

    const correlated = correlate(session)[0]?.requests[0]?.correlation;
    expect(correlated).toMatchObject({
      method: 'time-window', confidence: 'low', ownerActionIndex: 0,
    });
    expect(correlated?.evidence).toContain('137ms');
  });

  it('matches a query value when HTTP input precedes the later change event', () => {
    const session = baseSession();
    session.actions = [{ ts: 1_500, type: 'fill', label: 'Lookup', value: 'Alexandra' }];
    session.network = [{
      ...request('lookup', 1_100, 1_400), method: 'GET', mutating: false, postData: null,
      url: 'http://example.test/lookup?q=Alexandra',
    }];

    const owner = correlate(session).find((step) => step.requests.length > 0);
    expect(owner?.action?.value).toBe('Alexandra');
    expect(owner?.requests[0]?.correlation).toMatchObject({
      method: 'request-value-match', confidence: 'high',
    });
  });

  it('does not treat weak response scalars as DOM causality evidence', () => {
    const session = baseSession();
    session.actions = [
      {
        ts: 1_000, type: 'click', text: 'open',
        produces: {
          scopeId: 'sc1', root: { strategy: 'css', selector: '.panel-0' },
          kind: 'panel', portaled: false, appearedAfterMs: 10,
        },
      },
      { ts: 1_200, type: 'click', text: 'submit' },
    ];
    session.network = [{
      ...request('submit', 1_250, 1_300), responseBody: JSON.stringify({ code: 0 }),
    }];

    const owner = correlate(session).find((step) => step.requests.length > 0);
    expect(owner?.action?.text).toBe('submit');
    expect(owner?.requests[0]?.correlation?.method).toBe('time-window');
  });
});

function baseSession(): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome', entryId: 'oa' },
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
