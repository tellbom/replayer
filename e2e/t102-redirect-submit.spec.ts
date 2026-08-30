import { expect, test } from '@playwright/test';
import { StepSchema, parseEntry, type Entry, type ExecContext, type ParamDefinition } from '@dsh/core';
import { record } from '@dsh/recorder';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeNetworkStep } from '../packages/replayer/src/channel-network';
import { executeUiStep } from '../packages/replayer/src/channel-ui';
import { executePostcondition } from '../packages/replayer/src/engine';

const entry: Entry = {
  entry: {
    id: 'redirect-fixture', name: 'redirect fixture', via: 'direct',
    directUrl: 'http://redirect.test/form', landingUrlPattern: '/form',
    excludeUrlPatterns: [], sessionType: 'cookie',
    sessionProbe: { url: '/probe', okStatus: [200] },
    identityProbe: { url: '/identity', jsonPath: '$.id', requiresAuth: true },
    loginUrlPatterns: [], loginTimeoutMs: 300_000,
    sessionHolding: {
      strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000,
      cookieKind: 'unknown',
    },
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};

const params: ParamDefinition[] = [{ name: 'marker', type: 'string', required: true }];

test('T-102 persists the click and mutating request before a redirect response settles', async () => {
  let releaseSubmission: (() => void) | undefined;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (path === '/form') {
      response.setHeader('content-type', 'text/html');
      response.end('<form method="post" action="/submit"><button>send</button></form>');
    } else if (path === '/submit') {
      releaseSubmission = () => {
        response.writeHead(302, { location: '/done' });
        response.end();
      };
    } else if (path === '/probe') {
      response.setHeader('content-type', 'application/json');
      response.end('{"active":true}');
    } else if (path === '/identity') {
      response.setHeader('content-type', 'application/json');
      response.end('{"principal":"fixture"}');
    } else {
      response.setHeader('content-type', 'text/html');
      response.end('<html><body>done</body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'dsh-t102-partial-'));
  const outDir = join(root, 'out');
  const fixtureEntry = parseEntry(`
entry:
  id: partial-fixture
  name: partial fixture
  via: direct
  directUrl: ${baseUrl}/form
  landingUrlPattern: ${baseUrl}/form
  sessionType: cookie
  sessionProbe: { url: /probe, okStatus: [200] }
  identityProbe: { url: /identity, jsonPath: $.principal, requiresAuth: true }
  sessionHolding: { strategy: daemon, probeIntervalMs: 30000, stateTtlMs: 1800000 }
`);
  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  try {
    await record({
      entry: fixtureEntry, profileDir: join(root, 'profile'), outDir, headless: true, stopSignal,
      onReady: async (page) => {
        await page.evaluate(() => setTimeout(() => document.querySelector('button')?.click(), 0));
        const partial = await waitForPartial(join(outDir, 'record.partial.json'));
        expect(partial.canonicalActions.some((action) => action.kind === 'activate')).toBe(true);
        expect(partial.network.some((request) => request.method === 'POST')).toBe(true);
        expect(partial.network.find((request) => request.method === 'POST')?.status).toBeNull();
        if (!releaseSubmission) throw new Error('submission did not reach fixture');
        releaseSubmission();
        await page.waitForURL(`${baseUrl}/done`);
        stop();
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('T-102 network redirect remains unknown until the postcondition and never retries the write', async ({ page }) => {
  const records: Array<{ marker: string }> = [];
  await page.route('http://redirect.test/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/form') {
      await route.fulfill({ contentType: 'text/html', body: '<html><body>form</body></html>' });
    } else if (path === '/submit') {
      records.push(JSON.parse(request.postData() ?? '{}') as { marker: string });
      await route.fulfill({ status: 302, headers: { location: '/done' } });
    } else if (path === '/records') {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ items: records }) });
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<html><body>done</body></html>' });
    }
  });
  await page.goto('http://redirect.test/form');

  for (let index = 0; index < 5; index += 1) {
    const marker = `run-${index}`;
    const context = executionContext(marker);
    const step = StepSchema.parse({
      id: 'submit', desc: 'submit', channel: 'network', riskLevel: 'write',
      hasSideEffect: true, expectsRedirect: true,
      network: { method: 'POST', url: '/submit', body: { marker: '{{marker}}' } },
    });
    const outcome = await executeNetworkStep(page, step, context, params);
    expect(outcome.outcome).toBe('outcome_unknown');
    const resolution = await executePostcondition(page, {
      request: { method: 'GET', url: '/records' },
      match: { jsonPath: '$.items[*]', where: { marker: '{{marker}}' } },
      expectFound: true, timeoutMs: 1_000,
    }, context, params);
    expect(resolution.found).toBe(true);
  }
  expect(records).toHaveLength(5);
});

test('T-102 UI redirect waits for navigation before postcondition verification', async ({ page }) => {
  const records: Array<{ marker: string }> = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (path === '/form') {
      response.setHeader('content-type', 'text/html');
      response.end('<form method="post" action="/submit"><input name="marker" value="ui"><button>send</button></form>');
    } else if (path === '/submit') {
      records.push({ marker: 'ui' });
      response.writeHead(302, { location: '/done' });
      response.end();
    } else if (path === '/records') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ items: records }));
    } else {
      response.setHeader('content-type', 'text/html');
      response.end('<html><body>done</body></html>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture server did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await page.goto(`${baseUrl}/form`);
    const context = executionContext('ui', baseUrl);
    const step = StepSchema.parse({
      id: 'submit', desc: 'submit', channel: 'ui', riskLevel: 'write',
      hasSideEffect: true, expectsRedirect: true,
      ui: {
        action: 'click',
        target: { strategy: 'playwright', selector: 'button', confidence: 'HIGH' },
      },
    });
    const result = await executeUiStep(page, step, context, params);
    expect(result.ok).toBe(true);
    expect(page.url()).toBe(`${baseUrl}/done`);
    expect(await executePostcondition(page, {
      request: { method: 'GET', url: '/records' },
      match: { jsonPath: '$.items[*]', where: { marker: '{{marker}}' } },
      expectFound: true, timeoutMs: 1_000,
    }, context, params)).toMatchObject({ found: true });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

function executionContext(marker: string, baseUrl = 'http://redirect.test'): ExecContext {
  return {
    params: { marker }, vars: {}, stepResults: {}, baseUrl, entry,
    identityDigest: 'fixture', scopes: {},
  };
}

async function waitForPartial(path: string): Promise<{
  canonicalActions: Array<{ kind: string }>;
  network: Array<{ method: string; status: number | null }>;
}> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const partial = JSON.parse(await readFile(path, 'utf8')) as {
        canonicalActions?: Array<{ kind: string }>;
        network: Array<{ method: string; status: number | null }>;
      };
      if (partial.canonicalActions?.some((action) => action.kind === 'activate')
        && partial.network.some((request) => request.method === 'POST')) {
        return { canonicalActions: partial.canonicalActions, network: partial.network };
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw lastError ?? new Error('partial snapshot was not written');
}
