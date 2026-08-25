import { expect, test } from '@playwright/test';
import type { ExecContext, RecordedAction, RecordedFormState, Step } from '@dsh/core';
import { readFile } from 'node:fs/promises';

import { executeUiStep } from '../packages/replayer/src/channel-ui';

test('standard form recording captures select, radio, checkbox and initial state', async ({ page }) => {
  const actions: RecordedAction[] = [];
  const initial: RecordedFormState[] = [];
  await page.exposeBinding('__DSH_RECORD__', (_source, action: RecordedAction) => actions.push(action));
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
    Reflect.set(window, '__DSH_PWGEN__', (element: Element) => ({
      selector: `#${element.id}`, unique: true, matchCount: 1, confidence: 'HIGH',
    }));
    Reflect.set(window, '__DSH_EXTRACT_RECORDED_HINT__', () => ({
      action: 'check', visibleText: null, visibleTextSource: 'none', tagName: 'input',
      role: null, matchCountAtRecord: 1,
    }));
    Reflect.set(window, '__DSH_MUTATION__', {
      begin: () => undefined,
      end: async () => undefined,
      deriveScope: () => null,
    });
  });
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/recorder-probe.iife.js', 'utf8'),
  });

  await expect.poll(() => initial.length).toBe(2);
  await page.locator('#delivery').selectOption('air');
  await page.locator('#fast').check();
  await page.locator('#alerts').check();

  expect(initial).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'select', name: 'deliveryMode', value: 'ground', text: 'Ground' }),
    expect.objectContaining({ type: 'radio', name: 'cadence', value: 'slow', checked: true }),
  ]));
  expect(actions).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'select', name: 'deliveryMode', value: 'air', text: 'Air' }),
    expect.objectContaining({ type: 'radio', name: 'cadence', value: 'fast', checked: true }),
    expect.objectContaining({ type: 'checkbox', name: 'alerts', checked: true }),
  ]));
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
