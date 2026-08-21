import { describe, expect, it } from 'vitest';

import { StepSchema } from './schema.js';

describe('T-71 scope 契约', () => {
  it('保留原字段并填充 requires、portaled、timeoutMs 默认值', () => {
    const step = StepSchema.parse({
      id: 's1',
      desc: '打开确认框',
      channel: 'ui',
      ui: {
        action: 'click',
        scope: 'sc1',
        target: { strategy: 'playwright', selector: 'internal:role=button[name="确定"i]' },
      },
      produces: {
        scopeId: 'sc2',
        root: { strategy: 'playwright', selector: 'internal:role=dialog[name="确认"i]' },
        kind: 'dialog',
      },
      waitAfter: { scopeReady: 'sc2' },
    });

    expect(step.requires).toEqual([]);
    expect(step.produces?.portaled).toBe(false);
    expect(step.waitAfter?.timeoutMs).toBe(8_000);
    expect(step.ui?.scope).toBe('sc1');
  });
});
