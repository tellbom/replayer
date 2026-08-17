import { expect, test } from '@playwright/test';

import {
  classifyAuthFromResponse,
  recoverAuthentication,
  type AuthConfig,
} from '@dsh/browser';
import { login } from './helpers';

const auth: AuthConfig = {
  probeUrl: '/home',
  sessionApi: '/api/session?_nodelay=1',
  loggedInJsonPath: '$.loggedIn',
  loginUrlPatterns: ['/login'],
  loginDomMarkers: ['input[type="password"]'],
  loginTimeoutMs: 10_000,
};

test('session-recovery: 只恢复认证，调用方显式重试 safe GET', async ({ page }) => {
  await login(page);
  await page.evaluate(() => fetch('/api/_debug/expire?_nodelay=1', { method: 'POST' }));
  const businessPosts: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/overtime/')) {
      businessPosts.push(request.url());
    }
  });

  const recovery = recoverAuthentication(page, auth);
  await expect(page.locator('#__dsh_login_hint__')).toBeVisible();
  await page.evaluate(() =>
    fetch('/api/login?_nodelay=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'tester' }),
    }),
  );
  await recovery;
  expect(businessPosts).toHaveLength(0);

  const response = await page.evaluate(() =>
    fetch('/api/overtime/types?_nodelay=1').then(async (result) => ({
      status: result.status,
      body: await result.json(),
    })),
  );
  expect(response.status).toBe(200);
  expect(response.body).toHaveLength(3);
});

test('session-recovery: 403 分类为 forbidden 且不进入握手', async ({ page }) => {
  await login(page);
  expect(classifyAuthFromResponse(403, '/api/_debug/forbidden', auth)).toBe('forbidden');
  await expect(
    recoverAuthentication(page, { ...auth, sessionApi: '/api/_debug/forbidden?_nodelay=1' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(page.locator('#__dsh_login_hint__')).toHaveCount(0);
});

test('session-recovery: 401 与登录跳转分类为 unauthenticated', () => {
  expect(classifyAuthFromResponse(401, '/api/x', auth)).toBe('unauthenticated');
  expect(classifyAuthFromResponse(302, '/login?returnUrl=/home', auth)).toBe('unauthenticated');
});
