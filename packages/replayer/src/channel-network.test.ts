import type { Entry, ExecContext, Step } from '@dsh/core';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { executeNetworkStep, readJsonPath } from './channel-network.js';

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
    sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'unknown' },
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};

describe('executeNetworkStep', () => {
  it('requires a conditional JSONPath to identify exactly one array item', () => {
    const body = [
      { identifier: 'ACT-100', display: 'Alex' },
      { identifier: 'ACT-200', display: 'Bailey' },
    ];
    expect(readJsonPath(body, '$[?(@.display=="Alex")].identifier')).toBe('ACT-100');
    expect(() => readJsonPath(
      [...body, { identifier: 'ACT-300', display: 'Alex' }],
      '$[?(@.display=="Alex")].identifier',
    )).toThrow(/唯一命中/);
  });

  it('classifies a missing template variable as not_sent before page access', async () => {
    const step: Step = {
      id: 's1',
      desc: '缺失模板',
      channel: 'network',
      riskLevel: 'write',
      hasSideEffect: true,
      requires: [],
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
      scopes: {},
    };
    const result = await executeNetworkStep({} as Page, step, context, []);
    expect(result.outcome).toBe('not_sent');
  });
});
