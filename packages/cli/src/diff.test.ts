import type { RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { diffRecordings, renderRecordingDiff } from './diff.js';

describe('dsh diff', () => {
  it('reports changed action and request values while classifying CSRF as preflight', () => {
    const left = session('workday', '版本上线', 'csrf-a');
    const right = session('weekend', '紧急修复', 'csrf-b');
    const report = diffRecordings(left, right);
    const output = renderRecordingDiff(report);

    expect(report.warnings).toEqual([]);
    expect(report.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'action[0].value', suggestedParam: 'type' }),
        expect.objectContaining({ path: 'network[0].body.reason', suggestedParam: 'reason' }),
      ]),
    );
    expect(output).toContain('来自 preflight');
  });

  it('warns when action structures differ', () => {
    const left = session('workday', '版本上线', 'csrf-a');
    const right = session('weekend', '紧急修复', 'csrf-b');
    right.actions.push({ ts: 2, type: 'click' });
    expect(diffRecordings(left, right).warnings[0]).toContain('动作序列结构不一致');
  });
});

function session(type: string, reason: string, csrf: string): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome' },
    actions: [{ ts: 1, type: 'select', label: '加班类型', value: type }],
    network: [
      {
        requestId: 'request-1',
        requestTs: 1,
        responseTs: 2,
        method: 'POST',
        url: 'http://oa/api/overtime/submit',
        resourceType: 'fetch',
        headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
        postData: JSON.stringify({ type, reason }),
        status: 200,
        responseBody: '{}',
        mutating: true,
        sanitizeMode: 'structured',
      },
    ],
    pages: [],
  };
}
