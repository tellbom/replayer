import type { Entry, ExecContext, Skill } from '@dsh/core';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { executePreflights } from './preflight.js';

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

describe('executePreflights', () => {
  it('rejects non-DOM extraction without a request before touching the page', async () => {
    const preflights: Skill['preflight'] = [
      { name: 'token', extract: { type: 'jsonPath', path: '$.token' } },
    ];
    const context: ExecContext = {
      params: {},
      vars: {},
      stepResults: {},
      baseUrl: 'http://oa',
      entry: testEntry,
      identityDigest: '',
      scopes: {},
    };
    await expect(executePreflights({} as Page, preflights, context)).rejects.toThrow(
      /无 request.*DOM/,
    );
  });
});
