import type { RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { detectParams } from './params.js';

describe('detectParams', () => {
  it('uses the standard DOM name instead of a business-label dictionary', () => {
    const session = recording('工作日加班', 'unused');
    session.actions = [{ ts: 1, type: 'select', label: '请假类型', name: 'type', value: '年假' }];
    session.network = [{
      requestId: 'types', requestTs: 0.5, responseTs: 0.8, method: 'GET',
      url: 'http://oa/api/leave/types', resourceType: 'fetch', headers: {}, postData: null,
      status: 200, responseBody: JSON.stringify([{ label: '年假', value: 'annual' }]),
      mutating: false, sanitizeMode: 'structured',
    }];

    expect(detectParams(session)[0]?.definition).toMatchObject({
      name: 'type', enumMap: { 年假: 'annual' },
    });
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

  it('collects the complete enum map from a recorded options response', () => {
    const session = recording('工作日加班', '版本上线');
    session.network.unshift({
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
    expect(type?.enumMap).toEqual({
      工作日加班: 'workday', 周末加班: 'weekend', 节假日加班: 'holiday',
    });
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
