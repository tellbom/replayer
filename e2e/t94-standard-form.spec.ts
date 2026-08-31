import { expect, test } from '@playwright/test';
import { ENUM_CAPTURE, type CanonicalAction, type ExecContext, type RecordedFormState, type Step } from '@dsh/core';
import { readFile } from 'node:fs/promises';

import { executeUiStep } from '../packages/replayer/src/channel-ui';

test('standard form recording captures select, radio, checkbox and initial state', async ({ page }) => {
  const actions: CanonicalAction[] = [];
  const initial: RecordedFormState[] = [];
  await page.exposeBinding('__DSH_CANONICAL_RECORD__', (_source, action: CanonicalAction) => {
    const existing = actions.find((candidate) => candidate.actionIdx === action.actionIdx);
    if (existing) Object.assign(existing, action);
    else actions.push(action);
  });
  await page.exposeBinding(
    '__DSH_RECORD_INITIAL_STATE__',
    (_source, state: RecordedFormState) => initial.push(state),
  );
  await page.setContent(`
    <label for="delivery">Delivery mode</label>
    <select id="delivery" name="deliveryMode">
      <option value="ground" selected>Ground</option>
      <option value="air">Air</option>
    </select>
    <fieldset>
      <legend>Cadence</legend>
      <label><input id="slow" type="radio" name="cadence" value="slow" checked>Slow</label>
      <label><input id="fast" type="radio" name="cadence" value="fast">Fast</label>
    </fieldset>
    <label><input id="alerts" type="checkbox" name="alerts" value="enabled">Alerts</label>
  `);
  await page.evaluate(() => {
    Reflect.set(window, '__DSH_RECORDING__', true);
    Reflect.set(window, '__DSH_CANONICAL_SETTLE_MS__', 20);
    Reflect.set(window, '__DSH_CANONICAL_MAX_AFFECTED__', 20);
    Reflect.set(window, '__DSH_ENUM_MAX_OPTIONS__', 200);
    Reflect.set(window, '__DSH_PWGEN__', (element: Element) => ({
      selector: `#${element.id}`, unique: true, matchCount: 1, confidence: 'HIGH',
    }));
    Reflect.set(window, '__DSH_MUTATION__', {
      begin: () => undefined,
      end: async () => undefined,
      deriveScope: () => null,
    });
  });
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/canonical-recorder-probe.iife.js', 'utf8'),
  });

  await expect.poll(() => initial.length).toBe(2);
  await page.locator('#delivery').selectOption('air');
  await page.locator('#fast').check();
  await page.locator('#alerts').check();

  expect(initial).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'select', name: 'deliveryMode', value: 'ground', text: 'Ground' }),
    expect.objectContaining({ type: 'radio', name: 'cadence', value: 'slow', checked: true }),
  ]));
  await page.evaluate(async () => {
    const flush = Reflect.get(window, '__DSH_CANONICAL_FLUSH__');
    if (typeof flush === 'function') await flush();
  });
  expect(actions).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: 'select', target: expect.objectContaining({ name: 'deliveryMode' }),
      after: expect.objectContaining({ self: expect.objectContaining({ value: 'air' }) }),
      enumOptions: expect.objectContaining({ complete: true }),
    }),
    expect.objectContaining({
      kind: 'check', target: expect.objectContaining({ name: 'cadence', inputType: 'radio' }),
      after: expect.objectContaining({ self: expect.objectContaining({ checked: true }) }),
    }),
    expect.objectContaining({
      kind: 'check', target: expect.objectContaining({ name: 'alerts', inputType: 'checkbox' }),
      after: expect.objectContaining({ self: expect.objectContaining({ checked: true }) }),
    }),
  ]));
});

test('canonical form recording caps interaction-time enum evidence', async ({ page }) => {
  const actions: CanonicalAction[] = [];
  await page.exposeBinding('__DSH_CANONICAL_RECORD__', (_source, action: CanonicalAction) => {
    actions.push(action);
  });
  await page.setContent(`<select id="kind">${Array.from(
    { length: ENUM_CAPTURE.maxOptions + 5 },
    (_, index) => `<option value="v${index}">L${index}</option>`,
  ).join('')}</select>`);
  await page.evaluate((maxOptions) => {
    Reflect.set(window, '__DSH_RECORDING__', true);
    Reflect.set(window, '__DSH_CANONICAL_SETTLE_MS__', 20);
    Reflect.set(window, '__DSH_CANONICAL_MAX_AFFECTED__', 20);
    Reflect.set(window, '__DSH_ENUM_MAX_OPTIONS__', maxOptions);
    Reflect.set(window, '__DSH_PWGEN__', (element: Element) => ({
      selector: `#${element.id}`, unique: true, matchCount: 1, confidence: 'HIGH',
    }));
  }, ENUM_CAPTURE.maxOptions);
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/canonical-recorder-probe.iife.js', 'utf8'),
  });
  await page.locator('#kind').selectOption('v1');
  await page.evaluate(async () => {
    const flush = Reflect.get(window, '__DSH_CANONICAL_FLUSH__');
    if (typeof flush === 'function') await flush();
  });

  const evidence = actions.find((action) => action.kind === 'select')?.enumOptions;
  expect(evidence).toMatchObject({ complete: false, incompleteReason: 'truncated' });
  expect(evidence?.items).toHaveLength(ENUM_CAPTURE.maxOptions);
});

test('standard form replay uses native selectOption and check semantics', async ({ page }) => {
  await page.setContent(`
    <select id="delivery"><option value="ground">Ground</option><option value="air">Air</option></select>
    <input id="alerts" type="checkbox">
  `);
  const context = {
    params: {}, vars: {}, stepResults: {}, baseUrl: page.url(), scopes: {},
  } as ExecContext;
  await executeUiStep(page, step('select', {
    action: 'selectOption', target: { strategy: 'playwright', selector: '#delivery' }, value: 'air',
  }), context, []);
  await executeUiStep(page, step('check', {
    action: 'check', target: { strategy: 'playwright', selector: '#alerts' }, checked: true,
  }), context, []);

  await expect(page.locator('#delivery')).toHaveValue('air');
  await expect(page.locator('#alerts')).toBeChecked();
});

function step(id: string, ui: NonNullable<Step['ui']>): Step {
  return {
    id, desc: id, channel: 'ui', riskLevel: 'read', hasSideEffect: false,
    requires: [], ui,
  };
}
