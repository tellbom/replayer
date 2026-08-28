import { expect, test, type Page } from '@playwright/test';
import { downgradeToLegacyActions } from '@dsh/analyzer';
import type { CanonicalAction, RecordedAction } from '@dsh/core';
import { readFile } from 'node:fs/promises';

const generatorScript = await readFile('packages/locator/dist/pw-selector-generator.iife.js', 'utf8');
const mutationScript = await readFile('packages/locator/dist/mutation-tracker.iife.js', 'utf8');
const visibleHintScript = await readFile('packages/locator/dist/visible-hint.iife.js', 'utf8');
const legacyScript = await readFile('packages/locator/dist/recorder-probe.iife.js', 'utf8');
const canonicalScript = await readFile('packages/locator/dist/canonical-recorder-probe.iife.js', 'utf8');

test('Phase 1 shadow compare preserves every legacy action and records additional standard interactions', async ({ browser }) => {
  const legacyPage = await browser.newPage();
  const canonicalPage = await browser.newPage();
  try {
    const legacy = await captureLegacy(legacyPage);
    const canonical = await captureCanonical(canonicalPage);
    const derived = downgradeToLegacyActions(canonical);
    const legacySignatures = new Set(legacy.filter(actionable).map(signature));
    const canonicalSignatures = new Set(derived.filter(actionable).map(signature));
    const missingFromCanonical = [...legacySignatures].filter((item) => !canonicalSignatures.has(item));
    const additionalDerived = [...canonicalSignatures].filter((item) => !legacySignatures.has(item));

    console.log(`PHASE1_SHADOW=${JSON.stringify({
      legacyActions: legacySignatures.size,
      canonicalActions: canonical.length,
      canonicalDerivedActions: canonicalSignatures.size,
      missingFromCanonical: missingFromCanonical.length,
      additionalDerived: additionalDerived.length,
      unknownActions: canonical.filter((action) => action.kind === 'unknown').length,
    })}`);
    expect(missingFromCanonical).toEqual([]);
    expect(canonical.some((action) => action.kind === 'edit' && action.target?.role === 'textbox')).toBe(true);
    expect(canonical.some((action) => action.kind === 'unknown' && action.raw.eventTypes.includes('drop'))).toBe(true);
    expect(canonical.every((action) => action.raw.eventTypes.length > 0)).toBe(true);
  } finally {
    await legacyPage.close();
    await canonicalPage.close();
  }
});

async function captureLegacy(page: Page): Promise<RecordedAction[]> {
  const actions: RecordedAction[] = [];
  await page.exposeBinding('__DSH_RECORD__', (_source, emitted: RecordedAction) => actions.push(emitted));
  await installCommon(page);
  await page.addInitScript({ content: visibleHintScript });
  await page.addInitScript({ content: legacyScript });
  await exercise(page);
  return actions;
}

async function captureCanonical(page: Page): Promise<CanonicalAction[]> {
  const actions: CanonicalAction[] = [];
  await page.exposeBinding('__DSH_CANONICAL_RECORD__', (_source, emitted: CanonicalAction) => {
    const existing = actions.find((action) => action.actionIdx === emitted.actionIdx);
    if (existing) Object.assign(existing, emitted);
    else actions.push(emitted);
  });
  await installCommon(page);
  await page.addInitScript({ content: canonicalScript });
  await exercise(page);
  await page.evaluate(async () => {
    const flush = Reflect.get(window, '__DSH_CANONICAL_FLUSH__');
    if (typeof flush === 'function') await flush();
  });
  return actions;
}

async function installCommon(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Reflect.set(window, '__DSH_RECORDING__', true);
    Reflect.set(window, '__DSH_CANONICAL_SETTLE_MS__', 80);
    Reflect.set(window, '__DSH_CANONICAL_MAX_AFFECTED__', 20);
  });
  await page.addInitScript({ content: generatorScript });
  await page.addInitScript({ content: mutationScript });
}

async function exercise(page: Page): Promise<void> {
  const markup = encodeURIComponent(`<!doctype html><html><body>
    <label>Name <input name="name"></label>
    <button>Native action</button>
    <div role="button" aria-label="Custom action" tabindex="0">Custom action</div>
    <div role="textbox" aria-label="Rich editor" contenteditable="true"></div>
    <div id="drop-zone">Drop zone</div>
  </body></html>`);
  await page.goto(`data:text/html,${markup}`);
  await page.getByRole('button', { name: 'Native action' }).click();
  await page.getByLabel('Name').fill('value');
  await page.getByRole('button', { name: 'Custom action' }).click();
  await page.getByRole('textbox', { name: 'Rich editor' }).fill('rich value');
  await page.locator('#drop-zone').dispatchEvent('drop');
  await page.waitForTimeout(200);
}

function actionable(action: RecordedAction): boolean {
  return action.type !== 'navigate';
}

function signature(action: RecordedAction): string {
  const target = action.target;
  const selector = target && 'selector' in target ? target.selector : '';
  return `${action.type}|${selector}`;
}
