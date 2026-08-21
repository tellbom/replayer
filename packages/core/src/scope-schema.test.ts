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

describe('T-76 sessionHolding 契约', () => {
  it('使用 daemon 主路径默认值', async () => {
    const { parseEntry } = await import('./schema.js');
    const entry = parseEntry(`entry:
  id: oa
  name: OA
  via: direct
  directUrl: http://oa/home
  landingUrlPattern: /home
  sessionProbe: { url: /api/session, okStatus: [200] }
  identityProbe: { url: /api/userinfo, jsonPath: $.sub }
`);
    expect(entry.entry.sessionHolding).toEqual({
      strategy: 'daemon',
      probeIntervalMs: 30_000,
      stateTtlMs: 1_800_000,
      cookieKind: 'unknown',
    });
  });
});
