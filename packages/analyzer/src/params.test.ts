import type { RecordedRequest, RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { detectParams } from './params.js';
import { generateDraft } from './draft.js';
import { testSession, type MutableTestSession } from './test-session-fixture.js';

const NO_CAUSALITY = {
  actionIdx: null,
  causality: 'none',
  causalityDebug: null,
} as const satisfies Pick<RecordedRequest, 'actionIdx' | 'causality' | 'causalityDebug'>;

describe('detectParams', () => {
  it('uses the standard DOM name instead of a business-label dictionary', () => {
    const session = recording('工作日加班', 'unused');
    session.events = [{ ts: 1, type: 'select', label: '请假类型', name: 'type', value: '年假' }];
    session.network = [{
      ...NO_CAUSALITY,
      requestId: 'types', requestTs: 0.5, responseTs: 0.8, method: 'GET',
      url: 'http://oa/api/leave/types', resourceType: 'fetch', headers: {}, postData: null,
      status: 200, responseBody: JSON.stringify([{ label: '年假', value: 'annual' }]),
      mutating: false, sanitizeMode: 'structured',
    }, {
      ...NO_CAUSALITY,
      actionIdx: 0, causality: 'active-action', requestId: 'write', requestTs: 2, responseTs: 3,
      method: 'POST', url: 'http://oa/api/write', resourceType: 'fetch',
      headers: { 'content-type': 'application/json' }, postData: '{"type":"年假"}',
      status: 200, responseBody: '{}', mutating: true, sanitizeMode: 'structured',
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
        values: [
          { label: '工作日加班', value: 'workday' },
          { label: '周末加班', value: 'weekend' },
        ],
        enumMap: { 工作日加班: 'workday', 周末加班: 'weekend' },
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
    expect(type?.enumMap).toBeUndefined();
  });

  it('freezes a complete DOM option set only after cross-record stability evidence', () => {
    const first = recording('工作日加班', 'first-reason');
    const second = recording('周末加班', 'second-reason');
    const items = [
      { label: '工作日加班', value: 'workday' },
      { label: '周末加班', value: 'weekend' },
    ];
    first.events[0] = {
      ...first.events[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: { items, complete: true },
    };
    second.events[0] = {
      ...second.events[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: { items, complete: true },
    };

    const candidate = detectParams(first, second).find((item) => item.definition.name === 'type');
    expect(candidate?.enumStatus).toBe('static');
    expect(candidate?.definition.enumMap).toEqual({ 工作日加班: 'workday', 周末加班: 'weekend' });
  });

  it('V-108-8: marks an upstream-linked changed option set contextual instead of freezing it', () => {
    const first = recording('工作日加班', 'first-reason');
    const second = recording('纽约', 'second-reason');
    first.events[0] = {
      ...first.events[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: {
        items: [{ label: '工作日加班', value: 'workday' }, { label: '周末加班', value: 'weekend' }],
        complete: true,
      },
    };
    second.events[0] = {
      ...second.events[0]!, target: { strategy: 'css', selector: '#kind' },
      enumOptions: {
        items: [{ label: '纽约', value: 'nyc' }, { label: '旧金山', value: 'sfo' }],
        complete: true,
      },
    };
    first.events.unshift({
      ts: 0.5, type: 'select', value: 'scope-a',
      target: { strategy: 'css', selector: '#upstream' },
    });
    second.events.unshift({
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
    session.events.unshift({
      ts: 0.4, type: 'click', target: { strategy: 'css', selector: '#load' },
    });
    session.events[1] = {
      ...session.events[1]!, target: { strategy: 'css', selector: '#kind' }, text: '工作日加班',
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
    }, ...session.network.filter((request) => request.mutating)];

    expect(detectParams(session).find((item) => item.definition.name === 'type')?.definition.enumMap)
      .toEqual({ 工作日加班: 'workday', 周末加班: 'weekend' });
  });

  it('keeps distinct DOM sources separate when names and recorded values collide', () => {
    const session = recording('one', 'two');
    session.events = [
      { ts: 1, type: 'fill', name: 'shared', value: 'same', target: { strategy: 'css', selector: '#first' } },
      { ts: 2, type: 'fill', name: 'shared', value: 'same', target: { strategy: 'css', selector: '#second' } },
    ];
    session.network = [{
      ...NO_CAUSALITY,
      actionIdx: 1, causality: 'active-action', requestId: 'write', requestTs: 3, responseTs: 4,
      method: 'POST', url: 'http://oa/api/write', resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
      postData: '{"first":"same","second":"same"}', status: 200, responseBody: '{}',
      mutating: true, sanitizeMode: 'structured',
    }];

    expect(detectParams(session).map((item) => item.definition.name)).toEqual(['shared', 'shared_2']);
  });

  it('keeps distinct request fields when one source supplies multiple wire representations', () => {
    const session = testSession({
      meta: { startedAt: '', endedAt: '', baseUrl: 'http://fixture', userAgent: '', entryId: 'fixture' },
      pages: [],
      events: [{ ts: 1, type: 'fill', value: 'same', target: { strategy: 'css', selector: '#editor' } }],
      network: [{
        ...NO_CAUSALITY, actionIdx: 0, causality: 'active-action', requestId: 'write',
        requestTs: 2, responseTs: 3, method: 'POST', url: 'http://fixture/write',
        resourceType: 'fetch', headers: { 'content-type': 'application/json' },
        postData: '{"html":"same","text":"same"}', status: 200, responseBody: '{}',
        mutating: true, sanitizeMode: 'structured',
      }],
    });

    expect(detectParams(session).map((item) => item.definition.name)).toEqual(['html', 'text']);
  });

  it('names an aggregate request value by its wire field instead of a scalar editor name', () => {
    const session = testSession({
      meta: { startedAt: '', endedAt: '', baseUrl: 'http://fixture', userAgent: '', entryId: 'fixture' },
      pages: [],
      events: [{
        ts: 1, type: 'fill', name: 'tagInput', value: 'second',
        target: { strategy: 'css', selector: '#tag-input' },
      }],
      network: [{
        ...NO_CAUSALITY, actionIdx: 0, causality: 'active-action', requestId: 'write',
        requestTs: 2, responseTs: 3, method: 'POST', url: 'http://fixture/write',
        resourceType: 'fetch', headers: { 'content-type': 'application/json' },
        postData: '{"tags":["first","second"]}', status: 200, responseBody: '{}',
        mutating: true, sanitizeMode: 'structured',
      }],
    });

    expect(detectParams(session)[0]?.definition).toEqual(expect.objectContaining({
      name: 'tags', type: 'json',
    }));
  });

  it('models a request value found only in a causally owned non-form DOM mutation as internal page-derived', () => {
    const session: RecordSession = {
      meta: { startedAt: '', endedAt: '', baseUrl: 'http://fixture', userAgent: '', entryId: 'fixture' },
      pages: [],
      canonicalActions: [{
        id: 'a0', actionIdx: 0, timestamp: 1, kind: 'activate',
        target: {
          tag: 'button', role: 'button', accessibleName: '增加',
          locatorEvidence: { generatedSelector: '#add', confidence: 'HIGH' },
        },
        after: { self: { textContent: '增加' } },
        effects: {
          requestIds: ['write'],
          domMutations: [{
            locator: { strategy: 'playwright', selector: '#total', confidence: 'HIGH' },
            before: { textContent: '0' }, after: { textContent: '42' },
          }],
        },
        raw: { eventTypes: ['click'], trusted: true }, source: 'playwright-probe',
      }],
      network: [{
        ...NO_CAUSALITY, actionIdx: 0, causality: 'active-action',
        causalityDebug: { targetKey: 'button|add||0', kind: 'click', valueAtRequest: null, msSinceTouched: 1 },
        requestId: 'write', requestTs: 2, responseTs: 3, method: 'POST',
        url: 'http://fixture/write', resourceType: 'fetch', headers: { 'content-type': 'application/json' },
        postData: '{"total":42}', status: 200, responseBody: '{}', mutating: true,
        sanitizeMode: 'structured',
      }],
    };

    const skill = generateDraft(session).skill as typeof generateDraft extends (...args: never[]) => { skill: infer S }
      ? S & { internalValues?: Array<{ name: string; carrier?: { via: string } }> }
      : never;
    expect(skill.params).toEqual([]);
    expect(skill.internalValues).toEqual([expect.objectContaining({
      name: 'total', carrier: expect.objectContaining({ via: 'page-derived' }),
    })]);
    expect(skill.steps.find((step) => step.network?.method === 'POST')?.network?.body)
      .toEqual({ total: '{{total}}' });
  });

  it('treats a causally changed standard form value as caller input, not page-derived', () => {
    const session: RecordSession = {
      meta: { startedAt: '', endedAt: '', baseUrl: 'http://fixture', userAgent: '', entryId: 'fixture' },
      pages: [],
      canonicalActions: [{
        id: 'a0', actionIdx: 0, timestamp: 1, kind: 'activate',
        target: { tag: 'button', role: 'button', accessibleName: '18', locatorEvidence: { generatedSelector: '#day18', confidence: 'HIGH' } },
        effects: { domMutations: [{
          locator: { strategy: 'playwright', selector: '#end', confidence: 'HIGH' },
          before: { value: '', readonly: true }, after: { value: '2026-09-18', readonly: true },
        }] },
        raw: { eventTypes: ['click'], trusted: true }, source: 'playwright-probe',
      }],
      network: [{
        ...NO_CAUSALITY, actionIdx: 0, causality: 'active-action', requestId: 'write',
        requestTs: 2, responseTs: 3, method: 'POST', url: 'http://fixture/write',
        resourceType: 'fetch', headers: { 'content-type': 'application/json' },
        postData: '{"endDate":"2026-09-18"}', status: 200, responseBody: '{}',
        mutating: true, sanitizeMode: 'structured',
      }],
    };

    expect(detectParams(session)[0]?.definition).toEqual(expect.objectContaining({
      name: 'endDate', required: true,
      lineage: expect.objectContaining({ source: expect.objectContaining({ kind: 'user-input' }) }),
      carrier: expect.objectContaining({ via: 'network-body' }),
    }));
  });

  it('maps canonical DOM option labels to a unique context-free response value set', () => {
    const session: RecordSession = {
      meta: { startedAt: '', endedAt: '', baseUrl: 'http://fixture', userAgent: '', entryId: 'fixture' },
      pages: [],
      canonicalActions: [{
        id: 'a0', actionIdx: 0, timestamp: 20, kind: 'select',
        target: {
          role: 'combobox', accessibleName: 'Choice', name: 'searchText',
          locatorEvidence: { generatedSelector: '#choice', confidence: 'HIGH' },
        },
        after: {
          self: { textContent: 'Alpha' }, affectedTruncated: false,
          affected: [
            { locator: { strategy: 'playwright', selector: 'internal:role=option[name="Alpha"i]', confidence: 'HIGH' }, state: { textContent: 'Alpha', aria: { selected: 'true' } } },
            { locator: { strategy: 'playwright', selector: 'internal:role=option[name="Beta"i]', confidence: 'HIGH' }, state: { textContent: 'Beta', aria: { selected: 'false' } } },
          ],
        },
        raw: { eventTypes: ['click'], trusted: true }, source: 'playwright-probe',
      }],
      network: [
        {
          ...NO_CAUSALITY, requestId: 'options', requestTs: 10, responseTs: 11, method: 'GET',
          url: 'http://fixture/options', resourceType: 'fetch', headers: {}, postData: null,
          status: 200, responseBody: '[{"label":"Alpha","value":"A"},{"label":"Beta","value":"B"}]',
          mutating: false, sanitizeMode: 'structured',
        },
        {
          ...NO_CAUSALITY, requestId: 'first', requestTs: 30, responseTs: 31, method: 'POST',
          url: 'http://fixture/first', resourceType: 'fetch', headers: { 'content-type': 'application/json' },
          postData: '{"choice":"A"}', status: 200, responseBody: '{}', mutating: true,
          sanitizeMode: 'structured', actionIdx: 0, causality: 'active-action',
          causalityDebug: { targetKey: 'select|choice||0', kind: 'select', valueAtRequest: 'Alpha', msSinceTouched: 1 },
        },
        {
          ...NO_CAUSALITY, requestId: 'submit', requestTs: 40, responseTs: 41, method: 'POST',
          url: 'http://fixture/submit', resourceType: 'fetch', headers: { 'content-type': 'application/json' },
          postData: '{"choice":"A"}', status: 200, responseBody: '{}', mutating: true,
          sanitizeMode: 'structured', actionIdx: 0, causality: 'active-action',
          causalityDebug: { targetKey: 'button|||0', kind: 'click', valueAtRequest: null, msSinceTouched: 1 },
        },
      ],
    };

    const draft = generateDraft(session);
    expect(draft.skill.params[0]).toEqual(expect.objectContaining({
      name: 'choice', type: 'enum', values: [{ label: 'Alpha', value: 'A' }, { label: 'Beta', value: 'B' }],
      enumMap: { Alpha: 'A', Beta: 'B' },
    }));
    expect(draft.skill.steps.filter((step) => step.network?.body).map((step) => step.network!.body))
      .toEqual([{ choice: '{{choice|enumValue}}' }, { choice: '{{choice|enumValue}}' }]);
  });
});

function recording(type: string, reason: string): MutableTestSession {
  return testSession({
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome', entryId: 'oa' },
    events: [
      {
        ts: 1, type: 'select', label: '加班类型', name: 'type', value: type,
        affectedTruncated: false,
        affected: [
          {
            locator: { strategy: 'playwright', selector: 'internal:role=option[name="工作日加班"i]', confidence: 'HIGH' },
            state: { textContent: '工作日加班' },
          },
          {
            locator: { strategy: 'playwright', selector: 'internal:role=option[name="周末加班"i]', confidence: 'HIGH' },
            state: { textContent: '周末加班' },
          },
        ],
      },
      { ts: 2, type: 'datetime', label: '开始时间', name: 'startTime', value: '2026-08-18 18:00:00' },
      { ts: 3, type: 'datetime', label: '结束时间', name: 'endTime', value: '2026-08-18 21:00:00' },
      { ts: 4, type: 'fill', label: '事由', name: 'reason', value: reason },
      { ts: 5, type: 'fill', label: 'csrfToken', value: 'secret' },
    ],
    network: [
      {
        ...NO_CAUSALITY,
        requestId: 'types', requestTs: 0.2, responseTs: 0.4, method: 'GET',
        url: 'http://oa/api/overtime/types', resourceType: 'fetch', headers: {}, postData: null,
        status: 200, responseBody: JSON.stringify([
          { label: '工作日加班', value: 'workday' }, { label: '周末加班', value: 'weekend' },
        ]),
        mutating: false, sanitizeMode: 'structured',
      },
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
      {
        ...NO_CAUSALITY,
        actionIdx: 4,
        causality: 'active-action',
        causalityDebug: {
          targetKey: 'button|submit||0', kind: 'click', valueAtRequest: null, msSinceTouched: 10,
        },
        requestId: 'submit', requestTs: 5.1, responseTs: 5.2, method: 'POST',
        url: 'http://oa/api/overtime/submit', resourceType: 'fetch',
        headers: { 'content-type': 'application/json' },
        postData: JSON.stringify({
          type: type === '工作日加班' ? 'workday' : 'weekend',
          startTime: '2026-08-18 18:00:00', endTime: '2026-08-18 21:00:00', reason,
        }),
        status: 200, responseBody: '{}', mutating: true, sanitizeMode: 'structured',
      },
    ],
    pages: [],
  });
}
