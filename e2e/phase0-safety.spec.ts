import { expect, test } from '@playwright/test';
import type { Entry, ExecContext, Step } from '@dsh/core';
import { executeUiStep } from '@dsh/replayer';

const entry: Entry = { entry: {
  id: 'fixture', name: 'fixture', via: 'direct', directUrl: 'http://fixture/',
  landingUrlPattern: '/', excludeUrlPatterns: [], sessionType: 'cookie',
  sessionProbe: { url: '/session', okStatus: [200] },
  identityProbe: { url: '/identity', jsonPath: '$.id', requiresAuth: true },
  loginUrlPatterns: [], loginTimeoutMs: 1_000,
  sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'session' },
  credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
} };

test('Phase 0 stops a write when its UI carrier did not retain the expected value', async ({ page }) => {
  await page.setContent(`
    <input id="applicant">
    <button id="submit">Submit</button>
    <script>
      window.clicks = 0;
      document.querySelector('#applicant').addEventListener('input', (event) => { event.target.value = ''; });
      document.querySelector('#submit').addEventListener('click', () => { window.clicks += 1; });
    </script>
  `);
  const step: Step = {
    id: 'submit', desc: 'submit', channel: 'ui', riskLevel: 'write', hasSideEffect: true,
    requires: [],
    ui: {
      action: 'click',
      target: { strategy: 'playwright', selector: '#submit', confidence: 'HIGH' },
      preAction: {
        action: 'fill',
        target: { strategy: 'playwright', selector: '#applicant', confidence: 'HIGH' },
        value: '{{applicant}}',
      },
    },
  };
  const context: ExecContext = {
    params: { applicant: 'expected' }, vars: {}, stepResults: {}, baseUrl: page.url(),
    entry, identityDigest: '', scopes: {},
  };

  const result = await executeUiStep(page, step, context, [
    { name: 'applicant', type: 'string', required: true },
  ]);

  expect(result).toMatchObject({ outcome: 'not_sent', channelUsed: 'ui' });
  expect(result.error).toContain('UiCarrierIncompleteError');
  expect(await page.evaluate(() => (window as typeof window & { clicks: number }).clicks)).toBe(0);
});
