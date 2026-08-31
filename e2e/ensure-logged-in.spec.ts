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

test('T99: unknown shows a banner, waits, and continues after generic probe evidence appears', async ({ page }) => {
  let authenticated = false;
  await page.route('**/session-uncertain', (route) => route.fulfill({
    status: 200,
    contentType: authenticated ? 'application/json' : 'text/plain',
    body: authenticated ? JSON.stringify({ loggedIn: true }) : 'indeterminate',
  }));
  await page.goto('/login');
  await page.evaluate(() => history.replaceState({}, '', '/neutral'));
  await page.setContent('<main>neutral page</main>');
  await page.route('**/neutral', (route) => route.fulfill({
    status: 200, contentType: 'text/html', body: '<main>neutral page</main>',
  }));

  const handshake = ensureLoggedIn(page, {
    ...auth,
    probeUrl: '/neutral',
    sessionApi: '/session-uncertain',
    loginTimeoutMs: 4_000,
  });
  await expect(page.locator('#__dsh_login_hint__')).toContainText('无法确认登录状态');
  authenticated = true;
  await handshake;
  await expect(page.locator('#__dsh_login_hint__')).toHaveCount(0);
});

test('T99: unresolved auth ends as LoginTimeoutError instead of unknown-state crash', async ({ page }) => {
  await page.route('**/session-always-uncertain', (route) => route.fulfill({
    status: 200, contentType: 'text/plain', body: 'indeterminate',
  }));
  await page.goto('/login');
  await page.evaluate(() => history.replaceState({}, '', '/neutral'));
  await page.setContent('<main>neutral page</main>');

  await expect(ensureLoggedIn(page, {
    ...auth,
    probeUrl: '/neutral',
    sessionApi: '/session-always-uncertain',
    loginTimeoutMs: 100,
  })).rejects.toMatchObject({ code: 'LOGIN_TIMEOUT' });
});
