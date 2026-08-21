import type { Entry } from '@dsh/core';

/** 测试用 cookie 会话 entry（network 可用）。 */
export function testEntry(overrides: Partial<Entry['entry']> = {}): Entry {
  return {
    entry: {
      id: 'oa',
      name: 'OA',
      via: 'direct',
      directUrl: 'http://127.0.0.1:5173/login',
      landingUrlPattern: '/home',
      excludeUrlPatterns: ['\\?token=', '\\?ticket=', '/sso/callback', '/sso/redirect'],
      sessionType: 'cookie',
      sessionProbe: { url: '/api/session', jsonPath: '$.loggedIn', okStatus: [200] },
      identityProbe: { url: '/api/userinfo', jsonPath: '$.sub' },
      loginUrlPatterns: ['/login'],
      loginTimeoutMs: 300_000,
      sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'unknown' },
      credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
      ...overrides,
    },
  };
}
