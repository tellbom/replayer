import type { CanonicalAction } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { downgradeToLegacyActions } from './ir-downgrade.js';

describe('downgradeToLegacyActions', () => {
  it('maps only structurally equivalent canonical actions', () => {
    const actions: CanonicalAction[] = [
      action(0, 'activate', { self: { textContent: 'Open' } }),
      action(1, 'edit', { self: { value: 'final' } }),
      action(2, 'select', { self: { value: 'B' } }),
      action(3, 'check', { self: { value: 'x', checked: true } }),
      { ...action(4, 'navigate'), effects: { navigation: { url: 'https://example.test/next' } } },
    ];

    expect(downgradeToLegacyActions(actions)).toEqual([
      expect.objectContaining({ type: 'click', text: 'Open' }),
      expect.objectContaining({ type: 'fill', value: 'final' }),
      expect.objectContaining({ type: 'select', value: 'B' }),
      expect.objectContaining({ type: 'checkbox', value: 'x', checked: true }),
      expect.objectContaining({ type: 'navigate', url: 'https://example.test/next' }),
    ]);
  });

  it('keeps unknown, key, upload and state loss in an attached notes ledger', () => {
    const result = downgradeToLegacyActions([
      action(0, 'unknown', { self: { aria: { expanded: 'true' } } }),
      action(1, 'key'),
      action(2, 'upload', { self: { files: [{ name: 'safe.txt', size: 2, type: 'text/plain' }] } }),
      action(3, 'edit', { self: { value: 'x' }, affected: [] }),
    ]);

    expect(result).toHaveLength(1);
    expect(result._notes).toEqual(expect.arrayContaining([
      expect.stringContaining('actionIdx=0 kind=unknown'),
      expect.stringContaining('actionIdx=1 kind=key'),
      expect.stringContaining('actionIdx=2 kind=upload'),
      expect.stringContaining('actionIdx=3 lost=before/after/affected'),
    ]));
  });
});

function action(
  actionIdx: number,
  kind: CanonicalAction['kind'],
  after?: CanonicalAction['after'],
): CanonicalAction {
  return {
    id: `a${actionIdx}`,
    actionIdx,
    timestamp: 1_000 + actionIdx,
    kind,
    target: {
      tag: 'input', accessibleName: 'Field', name: 'field', inputType: 'text',
      locatorEvidence: { generatedSelector: '#field', confidence: 'HIGH' },
    },
    before: { self: { value: '' }, page: { url: 'https://example.test/' } },
    after,
    raw: { eventTypes: ['input'], trusted: true },
    source: 'playwright-probe',
  };
}
