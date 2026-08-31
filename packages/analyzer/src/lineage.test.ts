import type { CanonicalAction, RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { inferActionLineages } from './lineage.js';

describe('ValueLineage inference', () => {
  it('groups checked controls by standard name and distributes values by value identity', () => {
    const result = inferActionLineages(session([
      check(0, 'benefit', '医疗保险', 'A'),
      check(1, 'benefit', '交通补贴', 'C'),
    ]));

    expect(result).toEqual([expect.objectContaining({
      actionIndexes: [0, 1], recordedValue: ['A', 'C'],
      lineage: expect.objectContaining({
        cardinality: 'multiple',
        representation: expect.objectContaining({
          wire: 'enum',
          enumDomain: expect.objectContaining({ origin: 'recorded-only', complete: false }),
        }),
        identity: expect.objectContaining({ groupKey: 'name:benefit' }),
      }),
    })]);
  });

  it('keeps equal values from distinct source identities separate', () => {
    const first = edit(0, 'first', 'First field', 'same');
    const second = edit(1, 'second', 'Second field', 'same');
    const result = inferActionLineages(session([first, second]));

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.lineage.identity.controlKey)).toEqual([
      'name:first', 'name:second',
    ]);
  });

  it('treats a non-default single checkbox as enum and an on-valued checkbox as boolean', () => {
    const result = inferActionLineages(session([
      check(0, 'approval', 'Approval', 'YES'),
      check(1, 'notify', 'Notify', 'on'),
    ]));

    expect(result[0]?.lineage.representation.wire).toBe('enum');
    expect(result[1]?.lineage.representation.wire).toBe('boolean');
  });
});

function session(actions: CanonicalAction[]): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://fixture.invalid', userAgent: '', entryId: 'fixture' },
    canonicalActions: actions, network: [], pages: [],
  };
}

function check(index: number, name: string, label: string, value: string): CanonicalAction {
  return base(index, 'check', name, label, { value, checked: true });
}

function edit(index: number, name: string, label: string, value: string): CanonicalAction {
  return base(index, 'edit', name, label, { value });
}

function base(
  index: number,
  kind: CanonicalAction['kind'],
  name: string,
  label: string,
  self: NonNullable<CanonicalAction['after']>['self'],
): CanonicalAction {
  return {
    id: `a${index}`, actionIdx: index, timestamp: index + 1, kind,
    target: {
      tag: 'input', role: kind === 'check' ? 'checkbox' : 'textbox', name,
      accessibleName: label, inputType: kind === 'check' ? 'checkbox' : 'text',
      locatorEvidence: { generatedSelector: `input[name="${name}"]`, confidence: 'HIGH' },
    },
    after: { self }, raw: { eventTypes: [kind === 'check' ? 'change' : 'input'], trusted: true },
    source: 'playwright-probe',
  };
}
