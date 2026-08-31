import { expect, test } from '@playwright/test';
import { StepSchema, type ExecContext } from '@dsh/core';
import { readFile } from 'node:fs/promises';

import { executeUiStep } from '../packages/replayer/src/channel-ui.js';
import { oaEntry } from './fixture.js';

test('canonical scope replay resolves one produced root and rejects ambiguous or missing roots', async ({ page }) => {
  await page.setContent('<button id="open">Open</button><button>Confirm</button>');
  await page.locator('#open').evaluate((button) => {
    button.addEventListener('click', () => {
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      dialog.setAttribute('aria-label', 'Confirm action');
      dialog.innerHTML = '<button onclick="document.body.dataset.confirmed=\'yes\'">Confirm</button>';
      document.body.append(dialog);
    });
  });
  const context: ExecContext = {
    params: {}, vars: {}, stepResults: {}, baseUrl: 'http://example.test',
    entry: oaEntry, identityDigest: 'fixture', scopes: {},
  };
  const producer = StepSchema.parse({
    id: 's1', desc: 'open', channel: 'ui',
    ui: { action: 'click', target: { strategy: 'playwright', selector: '#open' } },
    produces: {
      scopeId: 'sc1',
      root: { strategy: 'playwright', selector: 'internal:role=dialog[name="Confirm action"i]' },
      kind: 'dialog',
    },
    waitAfter: { scopeReady: 'sc1', settleMs: 10 },
  });
  const consumer = StepSchema.parse({
    id: 's2', desc: 'confirm', channel: 'ui', requires: ['sc1'],
    ui: {
      action: 'click', scope: 'sc1',
      target: { strategy: 'playwright', selector: 'internal:role=button[name="Confirm"i]' },
    },
  });

  await executeUiStep(page, producer, context, []);
  await executeUiStep(page, consumer, context, []);
  await expect(page.locator('body')).toHaveAttribute('data-confirmed', 'yes');

  const duplicateRoot = StepSchema.parse({
    id: 's3', desc: 'open again', channel: 'ui',
    ui: { action: 'click', target: { strategy: 'playwright', selector: '#open' } },
    produces: {
      scopeId: 'sc2',
      root: { strategy: 'playwright', selector: 'internal:role=dialog[name="Confirm action"i]' },
      kind: 'dialog',
    },
    waitAfter: { scopeReady: 'sc2' },
  });
  await expect(executeUiStep(page, duplicateRoot, context, []))
    .rejects.toThrow('strict mode violation');

  const missingScope = StepSchema.parse({
    id: 's4', desc: 'missing scope', channel: 'ui',
    ui: {
      action: 'click', scope: 'missing',
      target: { strategy: 'playwright', selector: 'button' },
    },
  });
  await expect(executeUiStep(page, missingScope, context, [])).rejects.toThrow('missing');
});

test('generic waitAfter observes the causal response and a populated standard value carrier', async ({ page }) => {
  await page.addInitScript({
    content: await readFile('packages/locator/dist/dom-locator.iife.js', 'utf8'),
  });
  await page.route('http://fixture.invalid/**', async (route) => {
    if (new URL(route.request().url()).pathname === '/form') {
      await route.fulfill({
        contentType: 'text/html',
        body: `<button id="load">Load</button><input id="result"><script>
          load.onclick = async () => {
            await fetch('/dependency');
            setTimeout(() => { result.value = 'ready'; }, 100);
          };
        </script>`,
      });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
  });
  await page.goto('http://fixture.invalid/form');
  const context: ExecContext = {
    params: {}, vars: {}, stepResults: {}, baseUrl: 'http://fixture.invalid',
    entry: oaEntry, identityDigest: 'fixture', scopes: {},
  };
  const step = StepSchema.parse({
    id: 'load', desc: 'load dependency', channel: 'ui',
    ui: { action: 'click', target: { strategy: 'playwright', selector: '#load' } },
    waitAfter: {
      requestUrlPattern: '/dependency',
      notEmpty: { strategy: 'playwright', selector: '#result', confidence: 'HIGH' },
      timeoutMs: 2_000,
    },
  });

  await executeUiStep(page, step, context, []);

  await expect(page.locator('#result')).toHaveValue('ready');
});
