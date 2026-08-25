import type { RecordedRequest, RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { detectParams } from './params.js';

const NO_CAUSALITY = {
  actionIdx: null,
  causality: 'none',
  causalityDebug: null,
} as const satisfies Pick<RecordedRequest, 'actionIdx' | 'causality' | 'causalityDebug'>;

describe('detectParams', () => {
  it('uses the standard DOM name instead of a business-label dictionary', () => {
    const session = recording('工作日加班', 'unused');
    session.actions = [{ ts: 1, type: 'select', label: '请假类型', name: 'type', value: '年假' }];
    session.network = [{
      ...NO_CAUSALITY,
      requestId: 'types', requestTs: 0.5, responseTs: 0.8, method: 'GET',
      url: 'http://oa/api/leave/types', resourceType: 'fetch', headers: {}, postData: null,
      status: 200, responseBody: JSON.stringify([{ label: '年假', value: 'annual' }]),
      mutating: false, sanitizeMode: 'structured',
    }];

    expect(detectParams(session)[0]?.definition.name).toBe('type');
  });
  it('extracts four overtime parameters and excludes csrf', () => {
    const session = recording('工作日加班', '版本上线');
    const candidates = detectParams(session);

    expect(candidates.map((item) => item.definition.name)).toEqual([
      'type',
      'startTime',
      'endTime',
      'reason',
    ]);
    expect(candidates.find((item) => item.definition.name === 'type')?.definition).toEqual(
      expect.objectContaining({
        type: 'enum',
        values: [{ label: '工作日加班', value: 'workday' }],
        enumMap: { 工作日加班: 'workday' },
      }),
    );
    expect(candidates.find((item) => item.definition.name === 'startTime')?.definition.type).toBe(
      'datetime',
    );
    expect(candidates.some((item) => /csrf/i.test(item.definition.name))).toBe(false);
  });

  it('uses a second changed recording to boost confidence and collect enum values', () => {
    const first = recording('工作日加班', '版本上线');
    const second = recording('周末加班', '紧急修复');
    const candidates = detectParams(first, second);
    const type = candidates.find((item) => item.definition.name === 'type');

    expect(type?.confidence).toBe(1);
    expect(type?.definition.values).toEqual([
      { label: '工作日加班', value: 'workday' },
      { label: '周末加班', value: 'weekend' },
    ]);
  });

  it('does not freeze an uncorrelated options response', () => {
    const session = recording('工作日加班', '版本上线');
    session.network.unshift({
      ...NO_CAUSALITY,
      requestId: 'types', requestTs: 0.5, responseTs: 0.8, method: 'GET',
      url: 'http://oa/api/overtime/types', resourceType: 'fetch', headers: {}, postData: null,
      status: 200,
      responseBody: JSON.stringify([
        { label: '工作日加班', value: 'workday' },
        { label: '周末加班', value: 'weekend' },
        { label: '节假日加班', value: 'holiday' },
      ]),
      mutating: false, sanitizeMode: 'structured',
    });

    const type = detectParams(session).find((item) => item.definition.name === 'type')?.definition;
    expect(type?.enumMap).toEqual({ 工作日加班: 'workday' });
  });

  it('freezes a complete DOM option set only after cross-record stability evidence', () => {
    const first = recording('工作日加班', 'first-reason');
    const second = recording('周末加班', 'second-reason');
    const items = [
      { label: '工作日加班', value: 'workday' },
      { label: '周末加班', value: 'weekend' },
    ];
    first.actions[0] = {
      ...first.actions[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: { items, complete: true },
    };
    second.actions[0] = {
      ...second.actions[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: { items, complete: true },
    };

    const candidate = detectParams(first, second).find((item) => item.definition.name === 'type');
    expect(candidate?.enumStatus).toBe('static');
    expect(candidate?.definition.enumMap).toEqual({ 工作日加班: 'workday', 周末加班: 'weekend' });
  });

  it('V-108-8: marks an upstream-linked changed option set contextual instead of freezing it', () => {
    const first = recording('工作日加班', 'first-reason');
    const second = recording('纽约', 'second-reason');
    first.actions[0] = {
      ...first.actions[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: {
        items: [{ label: '工作日加班', value: 'workday' }, { label: '周末加班', value: 'weekend' }],
        complete: true,
      },
    };
    second.actions[0] = {
      ...second.actions[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: {
        items: [{ label: '纽约', value: 'nyc' }, { label: '旧金山', value: 'sfo' }],
        complete: true,
      },
    };
    first.actions.unshift({
      ts: 0.5, type: 'select', value: 'scope-a',
      target: { strategy: 'css', selector: '#upstream' },
    });
    second.actions.unshift({
      ts: 0.5, type: 'select', value: 'scope-b',
      target: { strategy: 'css', selector: '#upstream' },
    });
    first.network[0]!.actionIdx = 1;
    second.network[0]!.actionIdx = 1;

    const candidate = detectParams(first, second).find((item) => item.definition.name === 'type');
    expect(candidate?.enumStatus).toBe('contextual');
    expect(candidate?.definition.enumMap).toBeUndefined();
  });

  it('accepts response options only with recorded response-to-control evidence and no variable context', () => {
    const session = recording('工作日加班', 'reason');
    session.actions.unshift({
      ts: 0.4, type: 'click', target: { strategy: 'css', selector: '#load' },
      waitAfter: { notEmpty: { strategy: 'css', selector: '#kind' } },
    });
    session.actions[1] = {
      ...session.actions[1]!, target: { strategy: 'css', selector: '#kind' }, text: '工作日加班',
    };
    session.network = [{
      ...NO_CAUSALITY,
      actionIdx: 0, causality: 'active-action',
      causalityDebug: { targetKey: 'button|load||0', kind: 'click', valueAtRequest: null, msSinceTouched: 10 },
      requestId: 'options', requestTs: 0.5, responseTs: 0.8, method: 'GET',
      url: 'http://oa/options', resourceType: 'fetch', headers: {}, postData: null, status: 200,
      responseBody: JSON.stringify([
        { label: '工作日加班', value: 'workday' }, { label: '周末加班', value: 'weekend' },
      ]),
      mutating: false, sanitizeMode: 'structured',
    }];

    expect(detectParams(session).find((item) => item.definition.name === 'type')?.definition.enumMap)
      .toEqual({ 工作日加班: 'workday', 周末加班: 'weekend' });
  });

  it('keeps distinct DOM sources separate when names and recorded values collide', () => {
    const session = recording('one', 'two');
    session.actions = [
      { ts: 1, type: 'fill', name: 'shared', value: 'same', target: { strategy: 'css', selector: '#first' } },
      { ts: 2, type: 'fill', name: 'shared', value: 'same', target: { strategy: 'css', selector: '#second' } },
    ];
    session.network = [];

    expect(detectParams(session).map((item) => item.definition.name)).toEqual([
      'shared',
      'shared_2',
    ]);
  });
});

function recording(type: string, reason: string): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome', entryId: 'oa' },
    actions: [
      { ts: 1, type: 'select', label: '加班类型', name: 'type', value: type },
      { ts: 2, type: 'datetime', label: '开始时间', name: 'startTime', value: '2026-08-18 18:00:00' },
      { ts: 3, type: 'datetime', label: '结束时间', name: 'endTime', value: '2026-08-18 21:00:00' },
      { ts: 4, type: 'fill', label: '事由', name: 'reason', value: reason },
      { ts: 5, type: 'fill', label: 'csrfToken', value: 'secret' },
    ],
    network: [
      {
        ...NO_CAUSALITY,
        actionIdx: 0,
        causality: 'active-action',
        causalityDebug: {
          targetKey: 'select|type|select-one|0', kind: 'select', valueAtRequest: type,
          msSinceTouched: 10,
        },
        requestId: 'approver',
        requestTs: 1.5,
        responseTs: 1.8,
        method: 'POST',
        url: 'http://oa/api/overtime/approver',
        resourceType: 'fetch',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          type: type === '工作日加班' ? 'workday' : 'weekend',
        }),
        status: 200,
        responseBody: '{}',
        mutating: true,
        sanitizeMode: 'structured',
      },
    ],
    pages: [],
  };
}
