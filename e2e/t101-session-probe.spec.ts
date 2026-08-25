import { expect, test } from '@playwright/test';

import { probeSessionType } from '@dsh/browser';

test('V101-1: Cookie evidence is read from CDP ExtraInfo', async ({ page, context }) => {
  await page.goto('/login');
  await context.addCookies([{
    name: 'probe-session', value: 'present', url: page.url(), expires: Math.floor(Date.now() / 1000) + 60,
  }]);

  const result = await probeSessionType(page, '/api/session?_nodelay=1');
  expect(result).toMatchObject({
    sessionType: 'cookie',
    channelCapability: { network: true, ui: true },
  });
  expect(result.evidence).toContain('Cookie=true');
});

test('V101-4: correlated Authorization and Cookie evidence is mixed', async ({ page, context }) => {
  await page.goto('/login');
  await context.addCookies([{
    name: 'probe-session', value: 'present', url: page.url(), expires: Math.floor(Date.now() / 1000) + 60,
  }]);
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', 'Bearer regression-fixture');
      return original(input, { ...init, headers });
    };
  });

  const result = await probeSessionType(page, '/api/session?_nodelay=1');
  expect(result.sessionType).toBe('mixed');
  expect(result.evidence).toEqual(expect.arrayContaining([
    'Authorization=true', 'Cookie=true',
  ]));
});
