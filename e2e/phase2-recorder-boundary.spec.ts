import { expect, test, type Page } from '@playwright/test';
import type { CanonicalAction } from '@dsh/core';
import { readFile } from 'node:fs/promises';

const generatorScript = await readFile('packages/locator/dist/pw-selector-generator.iife.js', 'utf8');
const mutationScript = await readFile('packages/locator/dist/mutation-tracker.iife.js', 'utf8');
const canonicalScript = await readFile('packages/locator/dist/canonical-recorder-probe.iife.js', 'utf8');

test('Phase 2-0 records the target identity observed before a self-renaming activation', async ({ page }) => {
  const actions = await installCanonical(page, 40, `
    <button aria-label="＋ 华东"
      onclick="this.setAttribute('aria-label', '－ 华东')">toggle</button>
  `);

  await page.getByRole('button', { name: '＋ 华东' }).click();
  await flushCanonical(page);

  const activation = actions.find((action) => action.kind === 'activate');
  expect(activation?.target?.accessibleName).toBe('＋ 华东');
  await expect(page.getByRole('button', { name: '－ 华东' })).toBeVisible();
});

test('Phase 2-0 merges one stable-target pointer sequence across the settle boundary', async ({ page }) => {
  const actions = await installCanonical(page, 30, '<button id="save">Save</button>');

  await page.locator('#save').dispatchEvent('pointerdown');
  await page.waitForTimeout(40);
  await page.locator('#save').dispatchEvent('pointerup');
  await page.locator('#save').dispatchEvent('click');
  await page.waitForTimeout(100);
  await flushCanonical(page);

  const activations = actions.filter((action) => action.kind === 'activate');
  expect(activations).toHaveLength(1);
  expect(activations[0]?.raw.eventTypes).toEqual(['pointerdown', 'pointerup', 'click']);
});

async function installCanonical(
  page: Page,
  settleMs: number,
  body: string,
): Promise<CanonicalAction[]> {
  const actions: CanonicalAction[] = [];
  await page.exposeBinding('__DSH_CANONICAL_RECORD__', (_source, emitted: CanonicalAction) => {
    const existing = actions.find((action) => action.actionIdx === emitted.actionIdx);
    if (existing) Object.assign(existing, emitted);
    else actions.push(emitted);
  });
  await page.addInitScript((milliseconds) => {
    Reflect.set(window, '__DSH_RECORDING__', true);
    Reflect.set(window, '__DSH_CANONICAL_SETTLE_MS__', milliseconds);
    Reflect.set(window, '__DSH_CANONICAL_MAX_AFFECTED__', 20);
  }, settleMs);
  await page.addInitScript({ content: generatorScript });
  await page.addInitScript({ content: mutationScript });
  await page.addInitScript({ content: canonicalScript });
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><body>${body}</body>`)}`);
  return actions;
}

async function flushCanonical(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const flush = Reflect.get(window, '__DSH_CANONICAL_FLUSH__');
    if (typeof flush === 'function') await flush();
  });
  await page.waitForTimeout(80);
}
