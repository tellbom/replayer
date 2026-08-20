import type { Entry, ExecContext, Step } from '@dsh/core';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { executeNetworkStep } from './channel-network.js';

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
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};

describe('executeNetworkStep', () => {
  it('classifies a missing template variable as not_sent before page access', async () => {
    const step: Step = {
      id: 's1',
      desc: '缺失模板',
      channel: 'network',
      riskLevel: 'write',
      hasSideEffect: true,
      network: {
        method: 'POST',
        url: '/api/submit',
        contentType: 'json',
        body: { reason: '{{missing}}' },
      },
    };
    const context: ExecContext = {
      params: {},
      vars: {},
      stepResults: {},
      baseUrl: 'http://oa',
      entry: testEntry,
      identityDigest: '',
    };
    const result = await executeNetworkStep({} as Page, step, context, []);
    expect(result.outcome).toBe('not_sent');
  });
});
