import { expect, test } from '@playwright/test';
import { probeEntryAuthState, readIdentityDigest } from '@dsh/browser';

import { oaEntry } from './fixture';

test('T-92 同一端点可用通用 HTTP/数据流证据完成会话与身份探测', async ({ page }) => {
  await page.goto('/login');
  const probeUrl = '/capability-probe';
  const entry = {
    ...oaEntry,
    entry: {
      ...oaEntry.entry,
      sessionType: 'bearer' as const,
      bearerSource: { strategy: 'storage' as const, key: '^session\\.secret$' },
      sessionProbe: { url: probeUrl, okStatus: [200] },
      identityProbe: { url: probeUrl, jsonPath: '$.principal', requiresAuth: true as const },
      loginDomMarkers: ['input[type="password"]'],
    },
  };

  await page.route(`**${probeUrl}`, async (route) => {
    const authorization = route.request().headers().authorization;
    if (!authorization) {
      await route.fulfill({ status: 401, json: { authenticated: false } });
      return;
    }
    const principal = authorization.includes('identity-b') ? 'principal-b' : 'principal-a';
    await route.fulfill({ status: 200, json: { principal } });
  });

  await page.evaluate(() => localStorage.setItem('session.secret', 'eyJ.identity-a.token'));
  await expect(probeEntryAuthState(page, entry)).resolves.toBe('authenticated');
  const digestA = await readIdentityDigest(page, entry);

  await page.evaluate(() => localStorage.setItem('session.secret', 'eyJ.identity-b.token'));
  const digestB = await readIdentityDigest(page, entry);
  expect(digestB).not.toBe(digestA);

  await page.evaluate(() => localStorage.removeItem('session.secret'));
  await expect(probeEntryAuthState(page, entry)).resolves.toBe('unauthenticated');
});

test('T-92 非 JSON 响应只按通用登录证据判定，403 保持 forbidden', async ({ page }) => {
  await page.goto('/login');
  const entry = {
    ...oaEntry,
    entry: {
      ...oaEntry.entry,
      sessionProbe: { url: '/probe-state', okStatus: [200] },
      identityProbe: { url: '/probe-identity', jsonPath: '$.principal', requiresAuth: true as const },
      loginDomMarkers: ['input[type="password"]'],
    },
  };

  await page.route('**/probe-state', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<input type="password">' }),
  );
  await expect(probeEntryAuthState(page, entry)).resolves.toBe('unauthenticated');

  await page.unroute('**/probe-state');
  await page.route('**/probe-state', (route) => route.fulfill({ status: 403, body: 'forbidden' }));
  await expect(probeEntryAuthState(page, entry)).resolves.toBe('forbidden');

  await page.unroute('**/probe-state');
  await page.route('**/probe-state', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<main>indeterminate</main>' }),
  );
  await expect(probeEntryAuthState(page, entry)).resolves.toBe('unknown');
});
