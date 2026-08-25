import { parseSkill, type Entry, type RecordedRequest, type RecordSession } from '@dsh/core';

const NO_CAUSALITY = {
  actionIdx: null,
  causality: 'none',
  causalityDebug: null,
} as const satisfies Pick<RecordedRequest, 'actionIdx' | 'causality' | 'causalityDebug'>;

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
    identityProbe: { url: '/api/userinfo', jsonPath: '$.sub', requiresAuth: true },
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

import { assertParametersUsed, collapseIntermediateRequests, generateDraft } from './draft.js';

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
    expect(submit?.network?.headers).toEqual({
      authorization: '<FROM_BROWSER>',
      'content-type': 'application/json',
      'x-csrf-token': '<FROM_PREFLIGHT:csrfToken>',
      'x-tenant-context': 'tenant-a',
    });
    expect(result.skill._notes).toContain(
      '本技能包含 2 个录制时业务 header（content-type, x-tenant-context）；若其值需随调用变化，请人工改为参数引用。',
    );
    expect(parsed.postcondition).toEqual(
      expect.objectContaining({
        request: { method: 'GET', url: '/api/overtime/history?limit=5' },
        match: expect.objectContaining({
          jsonPath: '$.list[*]',
          where: expect.objectContaining({
            type: '{{type|enumValue}}',
            startTime: '{{startTime}}',
          }),
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

  it('keeps dotted keys intact while rejecting untraced write literals', () => {
    const session = recording(false);
    const submit = session.network.find((item) => item.url.includes('/submit'))!;
    submit.postData = JSON.stringify({
      clientId: 'dsh-test',
      attributes: { 'oauth2.device.authorization.grant.enabled': 'dsh-test' },
    });
    const result = generateDraft(session);
    expect(() => parseSkill(result.yaml, resolver())).toThrow(/TODO_UNRESOLVED/);
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

  it('marks a draft with LOW locator as requiring first-run verification', () => {
    const session = recording(false);
    session.actions[1]!.target = {
      strategy: 'playwright', selector: 'internal:role=textbox >> nth=5', confidence: 'LOW',
    };
    session.actions[1]!.recordedHint = {
      action: 'fill', visibleText: '开始时间', visibleTextSource: 'accessible-name',
      controlSemantics: null,
      tagName: 'input', role: 'textbox', matchCountAtRecord: 1,
    };
    const result = generateDraft(session);
    expect(result.skill.verification.requiresFirstRunVerification).toBe(true);
    expect(result.skill.steps[1]?.ui?.recordedHint?.visibleText).toBe('开始时间');
  });

  it('binds enum request fields to the caller parameter and rejects indexed response templates', () => {
    const session = recording(false);
    const second = recording(false);
    const enumItems = [
      { label: '工作日加班', value: 'workday' },
      { label: '周末加班', value: 'weekend' },
      { label: '节假日加班', value: 'holiday' },
    ];
    session.actions[0] = {
      ...session.actions[0]!, target: { strategy: 'css', selector: '#type' },
      enumOptions: { items: enumItems, complete: true },
    };
    second.actions[0] = {
      ...second.actions[0]!, value: '周末加班', target: { strategy: 'css', selector: '#type' },
      enumOptions: { items: enumItems, complete: true },
    };
    second.network.find((request) => request.url.includes('/approver'))!.postData = JSON.stringify({
      type: 'weekend',
    });
    session.network.unshift({
      ...NO_CAUSALITY,
      requestId: 'types', requestTs: 900, responseTs: 950, method: 'GET',
      url: 'http://oa/api/overtime/types', resourceType: 'fetch', headers: {}, postData: null,
      status: 200,
      responseBody: JSON.stringify([
        { label: '工作日加班', value: 'workday' },
        { label: '周末加班', value: 'weekend' },
        { label: '节假日加班', value: 'holiday' },
      ]),
      mutating: false, sanitizeMode: 'structured',
    });

    const result = generateDraft(session, second);
    const type = result.skill.params.find((param) => param.name === 'type');
    const bodies = result.skill.steps
      .filter((step) => step.network?.url.includes('/approver') || step.network?.url.includes('/submit'))
      .map((step) => step.network?.body?.type);

    expect(type?.enumMap).toEqual({
      工作日加班: 'workday', 周末加班: 'weekend', 节假日加班: 'holiday',
    });
    expect(bodies).toEqual(['{{type|enumValue}}', '{{type|enumValue}}']);
    expect(result.yaml).not.toMatch(/\{\{s\d+[^}]*\[\d+\]/);
    expect(result.skill.steps.find((step) => step.network?.url.includes('/submit'))?.network?.body)
      .toEqual(expect.objectContaining({
        approverId: expect.stringMatching(/^\{\{s\d+\.approverId\}\}$/),
        approvalToken: expect.stringMatching(/^\{\{s\d+\.approvalToken\}\}$/),
      }));
  });

  it('throws when a declared parameter is not referenced by any executable field', () => {
    const skill = generateDraft(recording(false)).skill;
    const reason = skill.params.find((param) => param.name === 'reason')!;
    const invalid = {
      ...skill,
      params: [reason],
      steps: skill.steps.map((step) => ({
        ...step,
        network: step.network ? { ...step.network, body: {} } : undefined,
        ui: step.ui ? { ...step.ui, value: '硬编码事由' } : undefined,
      })),
    };
    expect(() => assertParametersUsed(invalid)).toThrow(/参数 'reason' 已声明但未被任何步骤引用/);
  });

  it('persists high-confidence browser action causality', () => {
    const session = recording(false);
    session.network.unshift({
      ...NO_CAUSALITY,
      requestId: 'types', requestTs: 900, responseTs: 950, method: 'GET',
      url: 'http://oa/api/overtime/types', resourceType: 'fetch', headers: {}, postData: null,
      status: 200, responseBody: JSON.stringify([{ label: '工作日加班', value: 'workday' }]),
      mutating: false, sanitizeMode: 'structured',
    });
    const request = session.network.find((item) => item.requestId === 'approver')!;
    request.requestTs = 4_500;
    request.actionIdx = 0;
    request.causality = 'active-action';
    request.causalityDebug = {
      targetKey: 'select|type|select-one|0',
      kind: 'select',
      valueAtRequest: 'workday',
      msSinceTouched: 25,
    };

    const result = generateDraft(session);
    const approver = result.skill.steps.find((step) => step.network?.url.includes('/approver'));
    expect(approver?._correlation).toMatchObject({
      method: 'action-causality', confidence: 'high', ownerAction: approver?.id,
    });
    expect(result.yaml).not.toContain('TODO: 此请求的归属由时间窗推断（置信度低）');
  });

  it('parameterizes a standard control initial value even when the user does not change it', () => {
    const session = genericWriteSession({ deliveryMode: 'ground' });
    session.initialFormState = [{
      ts: 900,
      type: 'select',
      name: 'deliveryMode',
      label: 'Delivery mode',
      value: 'ground',
      text: 'Ground',
      target: { strategy: 'playwright', selector: '#delivery', confidence: 'HIGH' },
    }];

    const result = generateDraft(session);
    expect(result.skill.params).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'deliveryMode', type: 'enum' }),
    ]));
    expect(result.skill.steps[0]?.network?.body?.deliveryMode).toBe('{{deliveryMode|enumValue}}');
    expect(() => parseSkill(result.yaml, resolver())).not.toThrow();
  });

  it('rejects untraced write literals while exempting booleans, empty values and URL segments', () => {
    const session = genericWriteSession({
      deliveryMode: 'ground', enabled: true, note: '', items: [], clearedAt: null, route: 'jobs', page: 1,
    });
    const result = generateDraft(session);
    const body = result.skill.steps[0]?.network?.body;

    expect(body).toEqual({
      deliveryMode: 'TODO_UNRESOLVED', enabled: true, note: '', items: [], clearedAt: null, route: 'jobs',
      page: 'TODO_UNRESOLVED',
    });
    expect(result.skill._notes).toEqual(expect.arrayContaining([
      expect.stringContaining('deliveryMode'),
    ]));
    expect(result.yaml).toContain('该请求未携带 actionIdx，可能由页面自动触发而非用户操作。');
    expect(() => parseSkill(result.yaml, resolver())).toThrow(/TODO_UNRESOLVED/);
  });

  it('parameterizes a query and extracts a unique response item for a later write', () => {
    const result = generateDraft(responseChainSession([
      { identifier: 'ACT-100', display: 'Alex' },
    ]));
    const lookup = result.skill.steps.find((step) => step.network?.method === 'GET');
    const write = result.skill.steps.find((step) => step.network?.method === 'POST');

    expect(lookup?.network?.url).toBe('/lookup?q={{Assignee}}');
    expect(lookup?.network?.extract)
      .toEqual({ ownerId: '$[?(@.display=="{{Assignee}}")].identifier' });
    expect(write?.network?.body?.ownerId).toBe(`{{${lookup?.id}.ownerId}}`);
    expect(write?._correlation).toMatchObject({
      method: 'response-value-match', confidence: 'high',
    });
    expect(() => parseSkill(result.yaml, resolver())).not.toThrow();
  });

  it('folds progressive input requests and leaves an unrelated equal short value literal', () => {
    const active = (requestId: string, requestTs: number, value: string): RecordedRequest => ({
      ...NO_CAUSALITY,
      requestId,
      requestTs,
      responseTs: requestTs + 10,
      method: 'GET',
      url: `http://example.test/lookup?q=${value}`,
      resourceType: 'fetch',
      headers: {},
      postData: null,
      status: 200,
      responseBody: '{}',
      mutating: false,
      sanitizeMode: 'structured',
      actionIdx: 0,
      causality: 'active-action',
      causalityDebug: {
        targetKey: 'input|query|text|0', kind: 'input', valueAtRequest: value, msSinceTouched: 10,
      },
    });
    const session: RecordSession = {
      meta: {
        startedAt: '2026-08-25T00:00:00.000Z', endedAt: '2026-08-25T00:00:02.000Z',
        baseUrl: 'http://example.test', userAgent: 'test', entryId: 'generic',
      },
      actions: [{ ts: 1_000, type: 'fill', label: 'Query', name: 'query', value: '12' }],
      network: [
        {
          ...NO_CAUSALITY,
          requestId: 'listing', requestTs: 1_010, responseTs: 1_020, method: 'GET',
          url: 'http://example.test/listing?page=1', resourceType: 'fetch', headers: {},
          postData: null, status: 200, responseBody: '{}', mutating: false,
          sanitizeMode: 'structured',
        },
        active('lookup-1', 1_100, '1'),
        active('lookup-12', 1_200, '12'),
      ],
      pages: [],
    };

    expect(collapseIntermediateRequests(session.network).map((request) => request.requestId))
      .toEqual(['listing', 'lookup-12']);
    const result = generateDraft(session);
    const urls = result.skill.steps.flatMap((step) => step.network?.url ?? []);
    expect(urls).toContain('/listing?page=1');
    expect(urls).toContain('/lookup?q={{query}}');
    expect(urls).not.toContain('/lookup?q=1');
  });

  it('uses a unique user-value discriminator and rejects duplicate display values', () => {
    const unique = generateDraft(responseChainSession([
      { identifier: 'ACT-100', display: 'Alex' },
      { identifier: 'ACT-200', display: 'Bailey' },
    ]));
    expect(unique.skill.steps.find((step) => step.network?.method === 'GET')?.network?.extract)
      .toEqual({ ownerId: '$[?(@.display=="{{Assignee}}")].identifier' });

    const duplicate = generateDraft(responseChainSession([
      { identifier: 'ACT-100', display: 'Alex' },
      { identifier: 'ACT-200', display: 'Alex' },
    ]));
    const write = duplicate.skill.steps.find((step) => step.network?.method === 'POST');
    expect(write?.network?.body?.ownerId).toBe('TODO_UNRESOLVED');
    expect(() => parseSkill(duplicate.yaml, resolver())).toThrow(/TODO_UNRESOLVED/);
  });

  it('derives redirect semantics and a postcondition from browser and HTTP data flow', () => {
    const session = recording(true);
    const submit = session.network.find((item) => item.requestId === 'submit')!;
    submit.resourceType = 'document';
    session.pages = [
      { ts: 500, url: 'http://oa/form', title: 'Form' },
      { ts: 5_150, url: 'http://oa/records', title: 'Records' },
    ];

    const result = generateDraft(session);
    const redirectStep = result.skill.steps.find((step) => step.network?.url.includes('/submit'));
    expect(redirectStep?.expectsRedirect).toBe(true);
    expect(result.skill.assertions).toEqual([]);
    expect(result.skill.postcondition).toEqual(expect.objectContaining({
      request: { method: 'GET', url: '/api/overtime/history?limit=5' },
      match: expect.objectContaining({ jsonPath: '$.list[*]' }),
    }));
  });

  it('binds same-named controls by source lineage and parameterizes distinct leaf values', () => {
    const session = sameNamedControlsSession('recorded-first', 'recorded-second');
    const result = generateDraft(session);

    expect(result.skill.params.map((param) => param.name)).toEqual(['shared', 'shared_2']);
    expect(result.skill.steps.filter((step) => step.ui?.action === 'fill').map((step) => step.ui?.value))
      .toEqual(['{{shared}}', '{{shared_2}}']);
    expect(result.skill.steps.find((step) => step.network?.method === 'POST')?.network?.body)
      .toEqual({ first: '{{shared}}', second: '{{shared_2}}' });
  });

  it('blocks an ambiguous same-value write instead of silently choosing a source', () => {
    const result = generateDraft(sameNamedControlsSession('same', 'same'));
    const body = result.skill.steps.find((step) => step.network?.method === 'POST')?.network?.body;

    expect(result.skill.params.map((param) => param.name)).toEqual(['shared', 'shared_2']);
    expect(body).toEqual({ first: 'TODO_UNRESOLVED', second: 'TODO_UNRESOLVED' });
    expect(() => parseSkill(result.yaml, resolver())).toThrow(/TODO_UNRESOLVED/);
  });

  it('marks high-entropy identifiers as suspected without deleting the parameter source', () => {
    const session = sameNamedControlsSession('recorded-first', 'recorded-second');
    session.actions = [session.actions[0]!];
    session.actions[0] = {
      ...session.actions[0]!, name: 'field-a849b883', label: 'Field',
      target: { strategy: 'playwright', selector: '#field-a849b883', confidence: 'HIGH' },
    };
    session.network = [];

    const result = generateDraft(session);
    expect(result.skill.params[0]?.name).toBe('field-a849b883');
    expect(result.skill.steps[0]?.ui?.target).toEqual(expect.objectContaining({ confidence: 'LOW' }));
    expect(result.skill._notes?.some((note) => note.includes('疑似不稳定'))).toBe(true);
  });

  it('confirms cross-record identifier drift and excludes the unstable DOM name', () => {
    const first = sameNamedControlsSession('recorded-first', 'recorded-second');
    const second = sameNamedControlsSession('runtime-first', 'runtime-second');
    first.actions = [{
      ...first.actions[0]!, name: 'runtime-123abc', label: 'Field',
      recordedHint: {
        action: 'fill', visibleText: 'Field', visibleTextSource: 'label', controlSemantics: null,
        tagName: 'input', role: 'textbox', matchCountAtRecord: 1,
      },
    }];
    second.actions = [{ ...first.actions[0]!, name: 'runtime-987def' }];
    first.network = [];
    second.network = [];

    const result = generateDraft(first, second);
    expect(result.skill.params[0]?.name).toBe('Field');
    expect(result.skill._notes?.some((note) => note.includes('已确认不稳定'))).toBe(true);
  });

  it('contains malformed recording items without aborting the whole draft', () => {
    const malformedBodies = ['{broken', '[]', '"scalar"'];
    for (const postData of malformedBodies) {
      const session = sameNamedControlsSession('alpha-value', 'beta-value');
      session.network[0]!.postData = postData;
      expect(() => generateDraft(session)).not.toThrow();
    }

    const emptyText = sameNamedControlsSession('alpha-value', 'beta-value');
    emptyText.actions = [{ ts: 1, type: 'click', target: { strategy: 'css', selector: '#icon' } }];
    emptyText.network = [];
    expect(generateDraft(emptyText).skill.steps[0]?.desc).toBe('TODO_UNRESOLVED');

    const mixedAndLong = sameNamedControlsSession('混合-😀-value', 'x'.repeat(20_000));
    mixedAndLong.network = [];
    expect(() => generateDraft(mixedAndLong)).not.toThrow();
  });
});

function sameNamedControlsSession(first: string, second: string): RecordSession {
  return {
    meta: {
      startedAt: '2026-08-25T00:00:00.000Z', endedAt: '2026-08-25T00:00:04.000Z',
      baseUrl: 'http://example.test', userAgent: 'test', entryId: 'generic',
    },
    actions: [
      {
        ts: 1_000, type: 'fill', label: 'Field', name: 'shared', value: first,
        target: { strategy: 'css', selector: '#first' },
      },
      {
        ts: 2_000, type: 'fill', label: 'Field', name: 'shared', value: second,
        target: { strategy: 'css', selector: '#second' },
      },
      { ts: 3_000, type: 'click', label: 'Submit', target: { strategy: 'css', selector: '#submit' } },
    ],
    network: [{
      ...NO_CAUSALITY,
      actionIdx: 2,
      causality: 'active-action',
      causalityDebug: {
        targetKey: 'button|submit|button|0', kind: 'click', valueAtRequest: null, msSinceTouched: 10,
      },
      requestId: 'write', requestTs: 3_100, responseTs: 3_200, method: 'POST',
      url: 'http://example.test/records', resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ first, second }), status: 200, responseBody: '{}',
      mutating: true, sanitizeMode: 'structured',
    }],
    pages: [],
  };
}

function responseChainSession(items: Array<{ identifier: string; display: string }>): RecordSession {
  return {
    meta: {
      startedAt: '2026-08-25T00:00:00.000Z', endedAt: '2026-08-25T00:00:03.000Z',
      baseUrl: 'http://example.test', userAgent: 'test', entryId: 'oa',
    },
    actions: [
      { ts: 1_000, type: 'fill', label: 'Assignee', value: 'Alex' },
      { ts: 2_000, type: 'click', text: 'Confirm' },
    ],
    network: [
      {
        ...NO_CAUSALITY,
        actionIdx: 0,
        causality: 'active-action',
        causalityDebug: {
          targetKey: 'input|assignee|text|0', kind: 'input', valueAtRequest: 'Alex', msSinceTouched: 10,
        },
        requestId: 'lookup', requestTs: 1_100, responseTs: 1_200, method: 'GET',
        url: 'http://example.test/lookup?q=Alex', resourceType: 'fetch', headers: {}, postData: null,
        status: 200, responseBody: JSON.stringify(items), mutating: false, sanitizeMode: 'structured',
      },
      {
        ...NO_CAUSALITY,
        requestId: 'write', requestTs: 2_100, responseTs: 2_200, method: 'POST',
        url: 'http://example.test/jobs', resourceType: 'fetch',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({ ownerId: 'ACT-100' }), status: 200, responseBody: '{}',
        mutating: true, sanitizeMode: 'structured',
      },
    ],
    pages: [],
  };
}

function genericWriteSession(body: Record<string, unknown>): RecordSession {
  return {
    meta: {
      startedAt: '2026-08-25T00:00:00.000Z', endedAt: '2026-08-25T00:00:01.000Z',
      baseUrl: 'http://example.test', userAgent: 'test', entryId: 'oa',
    },
    actions: [{ ts: 1_000, type: 'click', text: 'Send' }],
    network: [{
      ...NO_CAUSALITY,
      requestId: 'write', requestTs: 1_100, responseTs: 1_200, method: 'POST',
      url: 'http://example.test/jobs', resourceType: 'fetch',
      headers: { 'content-type': 'application/json' }, postData: JSON.stringify(body),
      status: 200, responseBody: '{}', mutating: true, sanitizeMode: 'structured',
    }],
    pages: [],
  };
}

function recording(withHistory: boolean): RecordSession {
  const token = '<REDACTED:sha256:123456789abc>';
  const network: RecordSession['network'] = [
    {
      ...NO_CAUSALITY,
      actionIdx: 0,
      causality: 'active-action',
      causalityDebug: {
        targetKey: 'select|type|select-one|0', kind: 'select', valueAtRequest: 'workday',
        msSinceTouched: 10,
      },
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
      ...NO_CAUSALITY,
      actionIdx: 4,
      causality: 'active-action',
      causalityDebug: {
        targetKey: 'button|||0', kind: 'click', valueAtRequest: null, msSinceTouched: 10,
      },
      requestId: 'submit',
      requestTs: 5_100,
      responseTs: 5_200,
      method: 'POST',
      url: 'http://oa/api/overtime/submit',
      resourceType: 'fetch',
      headers: {
        'content-type': 'application/json',
        authorization: '<FROM_BROWSER>',
        'x-csrf-token': '<FROM_PREFLIGHT:csrfToken>',
        'x-tenant-context': 'tenant-a',
      },
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
      ...NO_CAUSALITY,
      requestId: 'history',
      requestTs: 6_100,
      responseTs: 6_200,
      method: 'GET',
      url: 'http://oa/api/overtime/history?limit=5',
      resourceType: 'fetch',
      headers: {},
      postData: null,
      status: 200,
      responseBody: JSON.stringify({
        list: [{
          type: 'workday',
          startTime: '2026-08-18 18:00:00',
          reason: '鐗堟湰涓婄嚎',
        }],
      }),
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
      { ts: 1_000, type: 'select', label: '加班类型', name: 'type', value: '工作日加班' },
      { ts: 2_000, type: 'datetime', label: '开始时间', name: 'startTime', value: '2026-08-18 18:00:00' },
      { ts: 3_000, type: 'datetime', label: '结束时间', name: 'endTime', value: '2026-08-18 21:00:00' },
      { ts: 4_000, type: 'fill', label: '事由', name: 'reason', value: '版本上线' },
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
