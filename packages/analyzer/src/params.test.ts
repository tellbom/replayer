import type { RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { detectParams } from './params.js';

describe('detectParams', () => {
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
});

function recording(type: string, reason: string): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome', entryId: 'oa' },
    actions: [
      { ts: 1, type: 'select', label: '加班类型', value: type },
      { ts: 2, type: 'datetime', label: '开始时间', value: '2026-08-18 18:00:00' },
      { ts: 3, type: 'datetime', label: '结束时间', value: '2026-08-18 21:00:00' },
      { ts: 4, type: 'fill', label: '事由', value: reason },
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
