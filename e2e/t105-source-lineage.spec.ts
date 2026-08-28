import { expect, test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { parseEntry } from '@dsh/core';
import type { ExecContext, RecordSession } from '@dsh/core';
import { readFile } from 'node:fs/promises';

import { executeNetworkStep } from '../packages/replayer/src/channel-network';
import { executeUiStep } from '../packages/replayer/src/channel-ui';

const entry = parseEntry(`
entry:
  id: source-lineage-fixture
  name: source lineage fixture
  via: direct
  directUrl: http://lineage.test/form
  landingUrlPattern: /form
  sessionType: cookie
  sessionProbe: { url: /probe, okStatus: [200] }
  identityProbe: { url: /identity, jsonPath: $.principal, requiresAuth: true }
  sessionHolding: { strategy: daemon, probeIntervalMs: 30000, stateTtlMs: 1800000 }
`);
const locatorScript = await readFile('packages/locator/dist/dom-locator.iife.js', 'utf8');

test('T-105 keeps two source lineages separate through UI, network, and stored record', async ({ page }) => {
  await page.addInitScript({ content: locatorScript });
  const stored: Array<{ first: string; second: string }> = [];
  await page.route('http://lineage.test/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/form') {
      await route.fulfill({
        contentType: 'text/html',
        body: '<input id="first" name="shared"><input id="second" name="shared"><button id="submit">Submit</button>',
      });
      return;
    }
    if (path === '/records' && request.method() === 'POST') {
      stored.push(JSON.parse(request.postData() ?? '{}') as { first: string; second: string });
      await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      return;
    }
    await route.fulfill({ contentType: 'application/json', body: '{}' });
  });
  await page.goto('http://lineage.test/form');

  const draft = generateDraft(recording());
  expect(draft.skill.steps.filter((step) => step.ui?.action === 'fill').map((step) => ({
    target: step.ui?.target,
    value: step.ui?.value,
  }))).toEqual([
    { target: { strategy: 'css', selector: '#first' }, value: '{{shared}}' },
    { target: { strategy: 'css', selector: '#second' }, value: '{{shared_2}}' },
  ]);
  const context: ExecContext = {
    params: { shared: 'runtime-first', shared_2: 'runtime-second' },
    vars: {}, stepResults: {}, baseUrl: 'http://lineage.test', entry,
    identityDigest: 'fixture', scopes: {},
  };
  for (const step of draft.skill.steps) {
    if (step.ui?.action === 'fill') await executeUiStep(page, step, context, draft.skill.params);
    if (step.network?.method === 'POST') {
      const result = await executeNetworkStep(page, step, context, draft.skill.params);
      expect(result.ok).toBe(true);
    }
  }

  expect(await page.locator('#first').inputValue()).toBe('runtime-first');
  expect(await page.locator('#second').inputValue()).toBe('runtime-second');
  expect(stored).toEqual([{ first: 'runtime-first', second: 'runtime-second' }]);

  // Reproduce the pre-fix failure shape: two distinct source lineages were
  // collapsed onto one parameter. The write is still executable and accepted,
  // which makes the defect a silent wrong-data path rather than a safe failure.
  const incorrectlyMergedStep = {
    id: 's-merged-write',
    name: 'reproduce incorrectly merged write',
    network: {
      method: 'POST' as const,
      url: '/records',
      headers: { 'content-type': 'application/json' },
      body: { first: '{{shared}}', second: '{{shared}}' },
    },
  };
  const mergedContext: ExecContext = {
    ...context,
    params: { shared: 'runtime-merged' },
  };
  const mergedResult = await executeNetworkStep(page, incorrectlyMergedStep, mergedContext, [{
    name: 'shared',
    type: 'string',
    required: true,
  }]);
  expect(mergedResult.ok).toBe(true);
  expect(stored[1]).toEqual({ first: 'runtime-merged', second: 'runtime-merged' });
});

function recording(): RecordSession {
  return {
    meta: {
      startedAt: '2026-08-25T00:00:00.000Z', endedAt: '2026-08-25T00:00:04.000Z',
      baseUrl: 'http://lineage.test', userAgent: 'test', entryId: entry.entry.id,
    },
    actions: [
      {
        ts: 1_000, type: 'fill', label: 'Field', name: 'shared', value: 'recorded-first',
        target: { strategy: 'css', selector: '#first' },
      },
      {
        ts: 2_000, type: 'fill', label: 'Field', name: 'shared', value: 'recorded-second',
        target: { strategy: 'css', selector: '#second' },
      },
      { ts: 3_000, type: 'click', label: 'Submit', target: { strategy: 'css', selector: '#submit' } },
    ],
    network: [{
      requestId: 'write', requestTs: 3_100, responseTs: 3_200, method: 'POST',
      url: 'http://lineage.test/records', resourceType: 'fetch',
      headers: { 'content-type': 'application/json' },
      postData: JSON.stringify({ first: 'recorded-first', second: 'recorded-second' }),
      status: 200, responseBody: '{"ok":true}', mutating: true, sanitizeMode: 'structured',
      actionIdx: 2, causality: 'active-action',
      causalityDebug: {
        targetKey: 'button|submit|button|0', kind: 'click', valueAtRequest: null, msSinceTouched: 10,
      },
    }],
    pages: [],
  };
}
