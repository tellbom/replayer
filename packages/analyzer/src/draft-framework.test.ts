import type { Skill } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { assertNoDeprecatedDraftStrategies } from './draft.js';

describe('new draft locator boundary', () => {
  it('rejects a deprecated framework-named strategy in generated output', () => {
    const strategy = ['el', 'form', 'item'].join('-');
    const skill = { steps: [{ id: 's1', ui: { target: { strategy } } }] } as unknown as Skill;
    expect(() => assertNoDeprecatedDraftStrategies(skill)).toThrow(/deprecated locator strategy/);
  });
});
