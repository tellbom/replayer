import { expect, test } from '@playwright/test';
import { executeNetworkStep } from '@dsh/replayer';
import type { ExecContext, Step } from '@dsh/core';

import { oaEntry } from './fixture';

test('T-93 运行时注入浏览器凭证与 preflight 值并保留业务 header', async ({ page }) => {
  await page.goto('/login');
  await page.evaluate(() => localStorage.setItem('runtime.session', 'eyJ.runtime.token'));
  let received: Record<string, string> = {};
  await page.route('**/runtime-header-check', async (route) => {
    received = route.request().headers();
    await route.fulfill({ status: 200, json: { ok: true } });
  });

  const entry = {
    ...oaEntry,
    entry: {
      ...oaEntry.entry,
      sessionType: 'bearer' as const,
      bearerSource: { strategy: 'storage' as const, key: '^runtime\\.session$' },
    },
  };
  const context: ExecContext = {
    params: {},
    vars: { csrfToken: 'csrf-runtime' },
    stepResults: {},
    baseUrl: page.url(),
    entry,
    identityDigest: 'digest',
    scopes: {},
  };
  const step: Step = {
    id: 's1',
    desc: 'runtime headers',
    channel: 'network',
    riskLevel: 'read',
    hasSideEffect: false,
    requires: [],
    network: {
      method: 'GET',
      url: '/runtime-header-check',
      headers: {
        Authorization: '<FROM_BROWSER>',
        'X-CSRF-Token': '<FROM_PREFLIGHT:csrfToken>',
        'X-Context': 'recorded-value',
      },
      contentType: 'json',
    },
  };

  const result = await executeNetworkStep(page, step, context, []);
  expect(result).toMatchObject({ ok: true, outcome: 'confirmed_success' });
  expect(received.authorization).toBe('Bearer eyJ.runtime.token');
  expect(received['x-csrf-token']).toBe('csrf-runtime');
  expect(received['x-context']).toBe('recorded-value');
});

test('T-93 运行时凭证或 preflight 值缺失时请求保持 not_sent', async ({ page }) => {
  await page.goto('/login');
  let requests = 0;
  await page.route('**/must-not-send', async (route) => {
    requests += 1;
    await route.fulfill({ status: 200, body: 'unexpected' });
  });
  const entry = {
    ...oaEntry,
    entry: {
      ...oaEntry.entry,
      sessionType: 'bearer' as const,
      bearerSource: { strategy: 'storage' as const, key: '^missing$' },
    },
  };
  const context: ExecContext = {
    params: {}, vars: {}, stepResults: {}, baseUrl: page.url(), entry,
    identityDigest: 'digest', scopes: {},
  };
  const step: Step = {
    id: 's1', desc: 'missing header', channel: 'network', riskLevel: 'write',
    hasSideEffect: true, requires: [],
    network: {
      method: 'POST', url: '/must-not-send', contentType: 'json',
      headers: { Authorization: '<FROM_BROWSER>' },
    },
  };
  const result = await executeNetworkStep(page, step, context, []);
  expect(result.outcome).toBe('not_sent');
  expect(requests).toBe(0);
});
