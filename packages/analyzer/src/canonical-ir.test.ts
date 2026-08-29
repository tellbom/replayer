import type { CanonicalAction, RecordedRequest, RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { generateDraft } from './draft.js';

describe('canonical IR analysis', () => {
  it('uses semantic target identity and binds the observed value to a request leaf', () => {
    const session = canonicalSession([action({
      target: {
        tag: 'input', role: 'textbox', accessibleName: '交接说明', name: 'handoffNote',
        locatorEvidence: { generatedSelector: 'internal:role=textbox[name="交接说明"i]', confidence: 'HIGH' },
      },
      after: { self: { value: 'recorded-note' } },
      effects: { requestIds: ['submit'] },
    })], [request({ handoffNote: 'recorded-note' })]);

    const result = generateDraft(session);

    expect(result.skill.params).toEqual([expect.objectContaining({ name: 'handoffNote', prompt: '交接说明' })]);
    expect(result.skill.steps.find((step) => step.network?.method === 'POST')?.network?.body)
      .toEqual({ handoffNote: '{{handoffNote}}' });
  });

  const malformed: Array<[string, (value: CanonicalAction) => void]> = [
    ['missing target', (value) => { delete value.target; }],
    ['null accessible name', (value) => { (value.target as unknown as { accessibleName: null }).accessibleName = null; }],
    ['missing before and after', (value) => { delete value.before; delete value.after; }],
    ['empty value', (value) => { value.after = { self: { value: '' } }; }],
    ['malformed enum evidence', (value) => { (value as unknown as { enumOptions: unknown }).enumOptions = { items: null }; }],
  ];

  it.each(malformed)('contains %s without a ZodError', (_name, mutate) => {
    const input = action({ kind: 'unknown', raw: { eventTypes: ['mystery'], trusted: true } });
    mutate(input);
    const result = generateDraft(canonicalSession([input], []));
    expect(result.skill.steps).toHaveLength(1);
    expect(result.skill._notes?.join('\n')).toMatch(/无法可靠标注语义|TODO|人工/);
  });
});

function action(overrides: Partial<CanonicalAction> = {}): CanonicalAction {
  return {
    id: 'a0', actionIdx: 0, timestamp: 1_000, kind: 'edit',
    target: {
      tag: 'input', role: 'textbox', accessibleName: 'Field', name: 'field',
      locatorEvidence: { generatedSelector: 'internal:role=textbox[name="Field"i]', confidence: 'HIGH' },
    },
    before: { self: { value: '' } }, after: { self: { value: 'value' } },
    effects: { requestIds: [] }, raw: { eventTypes: ['input'], trusted: true },
    source: 'playwright-probe', ...overrides,
  };
}

function request(body: Record<string, unknown>): RecordedRequest {
  return {
    requestId: 'submit', requestTs: 1_050, responseTs: 1_100, method: 'POST',
    url: 'http://fixture.invalid/records', resourceType: 'fetch',
    headers: { 'content-type': 'application/json' }, postData: JSON.stringify(body),
    status: 200, responseBody: '{"ok":true}', mutating: true, sanitizeMode: 'structured',
    actionIdx: 0, causality: 'active-action',
    causalityDebug: { targetKey: 'input|field|text|0', kind: 'input', valueAtRequest: String(Object.values(body)[0]), msSinceTouched: 10 },
  };
}

function canonicalSession(actions: CanonicalAction[], network: RecordedRequest[]): RecordSession {
  return {
    meta: {
      startedAt: '2026-08-29T00:00:00.000Z', endedAt: '2026-08-29T00:00:01.000Z',
      baseUrl: 'http://fixture.invalid', userAgent: 'test', entryId: 'fixture',
    },
    actions: [], canonicalActions: actions, recorderPath: 'canonical', network, pages: [],
  };
}
