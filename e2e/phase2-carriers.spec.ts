import { expect, test } from '@playwright/test';
import { DerivedParameterOverrideError } from '@dsh/core';
import type { ExecContext, InternalValueDefinition, ParamDefinition, Step } from '@dsh/core';
import { executeNetworkStep, executeUiStep, materializePageDerived } from '@dsh/replayer';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test('ui-upload sends the caller-provided file through the browser input', async ({ page }) => {
  const dir = join(process.cwd(), 'tmp', 'phase2-carriers');
  await mkdir(dir, { recursive: true });
  const path = join(dir, 'replacement.txt');
  await writeFile(path, 'replacement-content', 'utf8');
  await page.setContent('<input id="file" type="file"><script>window.changed=0;file.onchange=()=>window.changed++</script>');

  const result = await executeUiStep(page, uploadStep(), context({ attachment: path }), params());

  expect(result.ok).toBe(true);
  expect(await page.locator('#file').evaluate((input: HTMLInputElement) => ({
    name: input.files?.[0]?.name, changed: Reflect.get(window, 'changed'),
  }))).toEqual({ name: 'replacement.txt', changed: 1 });
});

test('ui-upload rejects a missing path before changing the browser input', async ({ page }) => {
  await page.setContent('<input id="file" type="file"><script>window.changed=0;file.onchange=()=>window.changed++</script>');

  const result = await executeUiStep(
    page, uploadStep(), context({ attachment: 'Z:\\definitely-missing\\file.txt' }), params(),
  );

  expect(result).toMatchObject({ ok: false, outcome: 'not_sent' });
  expect(await page.evaluate(() => Reflect.get(window, 'changed'))).toBe(0);
});

test('page-derived reads the causally recorded locator before network materialization', async ({ page }) => {
  const stored: unknown[] = [];
  await page.route('http://fixture.invalid/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/form') {
      await route.fulfill({ contentType: 'text/html', body: '<span id="total">42</span>' });
      return;
    }
    stored.push(JSON.parse(route.request().postData() ?? '{}'));
    await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('http://fixture.invalid/form');
  const derived: InternalValueDefinition[] = [{
    name: 'total', type: 'number',
    carrier: {
      via: 'page-derived',
      targetLocator: { strategy: 'playwright', selector: '#total', confidence: 'HIGH' },
    },
  } as InternalValueDefinition];
  const runContext = context({});
  const step: Step = {
    id: 'submit', desc: 'submit', channel: 'network', riskLevel: 'write', hasSideEffect: true,
    requires: [], network: { method: 'POST', url: '/submit', body: { total: '{{total}}' } },
  };

  await materializePageDerived(page, step, runContext, derived, {});
  const result = await executeNetworkStep(page, step, runContext, []);

  expect(result.ok).toBe(true);
  expect(stored).toEqual([{ total: 42 }]);
});

test('page-derived rejects an external override before the request is sent', async ({ page }) => {
  let submissions = 0;
  await page.route('http://fixture.invalid/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/form') {
      await route.fulfill({ contentType: 'text/html', body: '<span id="total">42</span>' });
      return;
    }
    submissions += 1;
    await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('http://fixture.invalid/form');
  const internal: InternalValueDefinition[] = [{
    name: 'total', type: 'number',
    lineage: {
      source: { kind: 'derived', dependsOn: ['action:0'] },
      representation: { wire: 'number', hasDisplayValue: false }, cardinality: 'single',
      identity: { controlKey: 'locator:#total', displayName: 'total' },
    },
    carrier: { via: 'page-derived', targetLocator: { strategy: 'playwright', selector: '#total', confidence: 'HIGH' } },
  }];
  const runContext = context({});
  const step: Step = {
    id: 'submit', desc: 'submit', channel: 'network', riskLevel: 'write', hasSideEffect: true,
    requires: [], network: { method: 'POST', url: '/submit', body: { total: '{{total}}' } },
  };

  await expect(materializePageDerived(page, step, runContext, internal, { total: 9 }))
    .rejects.toEqual(expect.objectContaining({
      name: 'DerivedParameterOverrideError',
      message: expect.stringContaining('当前传入值 9，页面实际值 42'),
    }));
  expect(submissions).toBe(0);
  expect(runContext.vars).toEqual({ total: 42 });
  expect(DerivedParameterOverrideError).toBeDefined();
});

function uploadStep(): Step {
  return {
    id: 'upload', desc: 'upload', channel: 'ui', riskLevel: 'write', hasSideEffect: false,
    requires: [], ui: {
      action: 'upload' as never,
      target: { strategy: 'playwright', selector: '#file', confidence: 'HIGH' },
      value: '{{attachment}}',
    },
  };
}

function params(): ParamDefinition[] {
  return [{ name: 'attachment', type: 'file', required: true } as ParamDefinition];
}

function context(values: Record<string, unknown>): ExecContext {
  return {
    params: values, vars: {}, stepResults: {}, baseUrl: 'http://fixture.invalid',
    entry: { entry: {
      id: 'fixture', name: 'fixture', via: 'direct', directUrl: 'http://fixture.invalid/form',
      landingUrlPattern: '/form', excludeUrlPatterns: [], sessionType: 'cookie',
      sessionProbe: { url: '/probe', okStatus: [200] },
      identityProbe: { url: '/identity', jsonPath: '$.id', requiresAuth: true },
      loginUrlPatterns: [], loginTimeoutMs: 1_000,
      sessionHolding: {
        strategy: 'probe-only', probeIntervalMs: 30_000, stateTtlMs: 1_800_000,
        cookieKind: 'unknown',
      },
      credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
    } },
    identityDigest: 'test', scopes: {},
  };
}
