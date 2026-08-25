import { expect, test } from '@playwright/test';

import { getAuthState, type AuthConfig } from '@dsh/browser';
import { login } from './helpers';

const auth: AuthConfig = {
  probeUrl: '/home',
  sessionApi: '/api/session?_nodelay=1',
  loggedInJsonPath: '$.loggedIn',
  loginUrlPatterns: ['/login'],
  loginDomMarkers: ['input[type="password"]'],
  loginTimeoutMs: 5_000,
};

test('auth-state: unauthenticated', async ({ page }) => {
  await page.goto('/login');
  await expect(getAuthState(page, auth)).resolves.toBe('unauthenticated');
});

test('auth-state: authenticated', async ({ page }) => {
  await login(page);
  await expect(getAuthState(page, auth)).resolves.toBe('authenticated');
});

test('auth-state: forbidden 不等于未登录', async ({ page }) => {
  await login(page);
  await expect(
    getAuthState(page, { ...auth, sessionApi: '/api/_debug/forbidden?_nodelay=1' }),
  ).resolves.toBe('forbidden');
});

test('auth-state: sessionApi 200 登录 HTML 判为 unauthenticated', async ({ page }) => {
  await page.route('**/api/session-html', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<html><body><form><input type="password"></form></body></html>',
    }),
  );
  await page.goto('/login');
  await page.evaluate(() => history.replaceState({}, '', '/neutral'));
  await page.setContent('<main>neutral page</main>');
  await expect(
    getAuthState(page, {
      ...auth,
      sessionApi: '/api/session-html',
      loggedInJsonPath: '$.loggedIn',
    }),
  ).resolves.toBe('unauthenticated');
});
