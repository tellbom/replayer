import { parseSkill, type Entry, type RecordSession } from '@dsh/core';

const testEntry: Entry = {
  entry: {
    id: 'oa',
    name: 'OA',
    via: 'direct',
    directUrl: 'http://oa/login',
    landingUrlPattern: '/home',
    excludeUrlPatterns: [],
    sessionType: 'cookie',
    sessionProbe: { url: '/api/session', okStatus: [200] },
    identityProbe: { url: '/api/userinfo', jsonPath: '$.sub' },
    loginUrlPatterns: [],
    loginTimeoutMs: 300_000,
    sessionHolding: {
      strategy: 'daemon',
      probeIntervalMs: 30_000,
      stateTtlMs: 1_800_000,
      cookieKind: 'unknown',
    },
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};
const resolver = (): ((id: string) => Entry) => () => testEntry;
import { describe, expect, it } from 'vitest';

import { generateDraft } from './draft.js';

describe('generateDraft', () => {
  it('creates a schema-valid YAML draft with dependency templates and TODO comments', () => {
    const result = generateDraft(recording(true));
    const parsed = parseSkill(result.yaml, resolver());
    const approver = parsed.steps.find((step) => step.network?.url.includes('/approver'));
    const submit = parsed.steps.find((step) => step.network?.url.includes('/submit'));

    expect((result.yaml.match(/# TODO/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(parsed.params.find((param) => param.name === 'type')?.values).toEqual([
      { label: '工作日加班', value: 'workday' },
    ]);
    expect(approver?.network?.extract).toEqual({
      approverId: '$.approverId',
      approvalToken: '$.approvalToken',
    });
    expect(submit?.network?.body).toEqual(
      expect.objectContaining({
        type: '{{type|enumValue}}',
        reason: '{{reason}}',
        approverId: `{{${approver?.id}.approverId}}`,
        approvalToken: `{{${approver?.id}.approvalToken}}`,
      }),
    );
    expect(submit?.riskLevel).toBe('write');
    expect(parsed.postcondition).toEqual(
      expect.objectContaining({
        request: { method: 'GET', url: '/api/overtime/history?limit=5' },
        match: expect.objectContaining({
          jsonPath: '$.list[*]',
          where: { startTime: '{{startTime}}', reason: '{{reason}}' },
        }),
      }),
    );
    expect(result.yaml).not.toContain('<REDACTED:sha256:123456789abc>');
  });

  it('writes an explicit safety TODO when no postcondition can be inferred', () => {
    const result = generateDraft(recording(false));
    expect(parseSkill(result.yaml, resolver()).postcondition).toBeUndefined();
    expect(result.yaml).toContain('TODO: 未能自动推断 postcondition');
    expect(result.yaml).toContain('响应丢失将中止');
  });

  it('keeps attribute keys containing dots intact when parameterizing bodies', () => {
    const session = recording(false);
    const submit = session.network.find((item) => item.url.includes('/submit'))!;
    submit.postData = JSON.stringify({
      clientId: 'dsh-test',
      attributes: { 'oauth2.device.authorization.grant.enabled': 'dsh-test' },
    });
    const result = generateDraft(session);
    expect(() => parseSkill(result.yaml, resolver())).not.toThrow();
    expect(result.yaml).toContain('oauth2.device.authorization.grant.enabled');
  });

  it('carries recorded produces, scope, requires and waitAfter into the draft', () => {
    const session: RecordSession = {
      meta: {
        startedAt: '2026-08-21T00:00:00.000Z',
        endedAt: '2026-08-21T00:00:01.000Z',
        baseUrl: 'http://oa',
        userAgent: 'test',
        entryId: 'oa',
      },
      actions: [
        {
          ts: 1,
          type: 'click',
          text: '提交',
          target: { strategy: 'playwright', selector: 'internal:role=button[name="提交"i]' },
          produces: {
            scopeId: 'sc1',
            root: { strategy: 'playwright', selector: 'internal:role=dialog[name="确认"i]' },
            kind: 'dialog',
            portaled: true,
            appearedAfterMs: 30,
          },
          waitAfter: { scopeReady: 'sc1', settleMs: 200, timeoutMs: 8_000 },
        },
        {
          ts: 2,
          type: 'click',
          text: '确定',
          scope: 'sc1',
          target: {
            strategy: 'playwright',
            selector: 'internal:role=button[name="确定"i]',
            confidence: 'HIGH',
          },
        },
      ],
      network: [],
      pages: [],
    };

    const { skill } = generateDraft(session);
    expect(skill.steps[0]?.produces).toMatchObject({ scopeId: 'sc1', kind: 'dialog' });
    expect(skill.steps[0]?.waitAfter).toMatchObject({ scopeReady: 'sc1', settleMs: 200 });
    expect(skill.steps[1]?.requires).toEqual(['sc1']);
    expect(skill.steps[1]?.ui?.scope).toBe('sc1');
  });

  it('marks a session interruption and drops the stale scope from the first resumed action', () => {
    const session = recording(false);
    session.actions[1]!.scope = 'stale-listbox';
    session.interruptions = [
      {
        type: 'session-interrupt',
        atActionIdx: 1,
        detectedAt: '2026-08-21T00:00:00.000Z',
        resumedAt: '2026-08-21T00:00:02.000Z',
      },
    ];

    const result = generateDraft(session);
    expect(result.skill.steps[1]?.requires).toEqual([]);
    expect(result.skill.steps[1]?.ui?.scope).toBeUndefined();
    expect(result.skill._notes).toEqual(
      expect.arrayContaining([expect.stringContaining('reentry.anchor 候选为 s2')]),
    );
  });
});

function recording(withHistory: boolean): RecordSession {
  const token = '<REDACTED:sha256:123456789abc>';
  const network: RecordSession['network'] = [
    {
      requestId: 'approver',
      requestTs: 1_100,
      responseTs: 1_200,
      method: 'POST',
      url: 'http://oa/api/overtime/approver',
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
      requestTs: 5_100,
      responseTs: 5_200,
      method: 'POST',
      url: 'http://oa/api/overtime/submit',
      resourceType: 'fetch',
      headers: { 'content-type': 'application/json', 'x-csrf-token': 'fingerprint' },
      postData: JSON.stringify({
        type: 'workday',
        startTime: '2026-08-18 18:00:00',
        endTime: '2026-08-18 21:00:00',
        reason: '版本上线',
        approverId: 1023,
        approvalToken: token,
      }),
      status: 200,
      responseBody: JSON.stringify({ code: 0, no: 'OT-1' }),
      mutating: true,
      sanitizeMode: 'structured',
    },
  ];
  if (withHistory) {
    network.push({
      requestId: 'history',
      requestTs: 6_100,
      responseTs: 6_200,
      method: 'GET',
      url: 'http://oa/api/overtime/history?limit=5',
      resourceType: 'fetch',
      headers: {},
      postData: null,
      status: 200,
      responseBody: JSON.stringify({ list: [] }),
      mutating: false,
      sanitizeMode: 'structured',
    });
  }
  return {
    meta: {
      startedAt: '2026-08-18T00:00:00.000Z',
      endedAt: '2026-08-18T00:01:00.000Z',
      baseUrl: 'http://oa',
      userAgent: 'Chrome',
      entryId: 'oa',
    },
    actions: [
      { ts: 1_000, type: 'select', label: '加班类型', value: '工作日加班' },
      { ts: 2_000, type: 'datetime', label: '开始时间', value: '2026-08-18 18:00:00' },
      { ts: 3_000, type: 'datetime', label: '结束时间', value: '2026-08-18 21:00:00' },
      { ts: 4_000, type: 'fill', label: '事由', value: '版本上线' },
      {
        ts: 5_000,
        type: 'click',
        text: '确认提交',
        target: { strategy: 'role', role: 'button', name: '确认提交' },
      },
    ],
    network,
    pages: [],
  };
}
