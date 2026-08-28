import type { Entry, ExecContext, Step } from '@dsh/core';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { executeUiStep } from './channel-ui.js';

describe('Phase 0 UI runtime materialization gate', () => {
  it('returns not_sent for a materialized TODO before locator access', async () => {
    const step: Step = {
      id: 'write', desc: 'write', channel: 'ui', riskLevel: 'write', hasSideEffect: true,
      requires: [],
      ui: {
        action: 'fill',
        target: { strategy: 'playwright', selector: '#field', confidence: 'HIGH' },
        value: '{{value}}',
      },
    };

    const result = await executeUiStep({} as Page, step, context({ value: 'TODO_UNRESOLVED' }), [
      { name: 'value', type: 'string', required: true },
    ]);

    expect(result).toMatchObject({ outcome: 'not_sent', channelUsed: 'ui' });
    expect(result.error).toMatch(/TODO_UNRESOLVED/);
  });
});

function context(params: Record<string, unknown>): ExecContext {
  return {
    params, vars: {}, stepResults: {}, baseUrl: 'http://fixture', identityDigest: '', scopes: {},
    entry: { entry: {
      id: 'fixture', name: 'fixture', via: 'direct', directUrl: 'http://fixture/',
      landingUrlPattern: '/', excludeUrlPatterns: [], sessionType: 'cookie',
      sessionProbe: { url: '/session', okStatus: [200] },
      identityProbe: { url: '/identity', jsonPath: '$.id', requiresAuth: true },
      loginUrlPatterns: [], loginTimeoutMs: 1_000,
      sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'session' },
      credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
    } } satisfies Entry,
  };
}
