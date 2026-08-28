import { expect, test } from '@playwright/test';

import type { Entry, ExecContext, Step } from '@dsh/core';
import { executeUiStep } from '../packages/replayer/src/channel-ui';

test('Phase 1: a multi-match semantic target fails strict mode without clicking the first match', async ({ page }) => {
  await page.setContent(`
    <button onclick="this.dataset.clicked='yes'">Continue</button>
    <button onclick="this.dataset.clicked='yes'">Continue</button>
  `);
  const step: Step = {
    id: 'strict', desc: 'strict', channel: 'ui', riskLevel: 'read', hasSideEffect: false,
    ui: { action: 'click', target: { strategy: 'role', role: 'button', name: 'Continue' } },
  };

  await expect(executeUiStep(page, step, context(), []))
    .rejects.toThrow(/strict mode violation/);
  await expect(page.locator('[data-clicked="yes"]')).toHaveCount(0);
});

test('Phase 1: fill writes a readonly standard input through its live IDL property', async ({ page }) => {
  await page.setContent('<label for="date">Date</label><input id="date" readonly>');
  const step: Step = {
    id: 'idl', desc: 'idl', channel: 'ui', riskLevel: 'read', hasSideEffect: false,
    ui: { action: 'fill', value: '2026-08-28 18:00:00', target: { strategy: 'playwright', selector: '#date' } },
  };

  await executeUiStep(page, step, context(), []);

  await expect(page.locator('#date')).toHaveJSProperty('value', '2026-08-28 18:00:00');
  await expect(page.locator('#date')).not.toHaveAttribute('value', '2026-08-28 18:00:00');
});

function context(): ExecContext {
  return {
    params: {}, vars: {}, stepResults: {}, baseUrl: 'https://example.test',
    entry: { entry: { id: 'fixture' } } as Entry, identityDigest: 'fixture', scopes: {},
  };
}
