import { expect, test } from '@playwright/test';

import { ensureLoggedIn, type AuthConfig } from '@dsh/browser';
import { login } from './helpers';

const auth: AuthConfig = {
  probeUrl: '/home',
  sessionApi: '/api/session?_nodelay=1',
  loggedInJsonPath: '$.loggedIn',
  loginUrlPatterns: ['/login'],
  loginDomMarkers: ['input[type="password"]'],
  loginTimeoutMs: 10_000,
};

test('ensureLoggedIn: session 过期后等待用户重新登录', async ({ page }) => {
  await login(page);
  await page.evaluate(() => fetch('/api/_debug/expire?_nodelay=1', { method: 'POST' }));

  const handshake = ensureLoggedIn(page, auth);
  await expect(page.locator('#__dsh_login_hint__')).toBeVisible();
  await page.evaluate(() =>
    fetch('/api/login?_nodelay=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'tester' }),
    }),
  );
  await handshake;

  await expect(page.locator('#__dsh_login_hint__')).toHaveCount(0);
});

test('ensureLoggedIn: 403 立即失败且不显示登录横幅', async ({ page }) => {
  await login(page);
  await expect(
    ensureLoggedIn(page, { ...auth, sessionApi: '/api/_debug/forbidden?_nodelay=1' }),
  ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  await expect(page.locator('#__dsh_login_hint__')).toHaveCount(0);
});
