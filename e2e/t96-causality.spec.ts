import { expect, test } from '@playwright/test';
import { record } from '@dsh/recorder';

import { oaEntry, seedProfile } from './fixture';

test('T-96a: browser action causality distinguishes equal input and unrelated request values', async ({ browserName }, testInfo) => {
  void browserName;
  const profileDir = testInfo.outputPath('profile');
  const outDir = testInfo.outputPath('recording');
  await seedProfile(profileDir);

  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  const session = await record({
    entry: oaEntry,
    profileDir,
    outDir,
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.route('**/causality-fixture/**', async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true }),
        });
      });
      await page.evaluate(() => {
        document.body.innerHTML = `
          <main>
            <label>Lookup <input name="lookup" /></label>
            <label>Other <input name="other" /></label>
          </main>`;
        const lookup = document.querySelector<HTMLInputElement>('input[name="lookup"]')!;
        const other = document.querySelector<HTMLInputElement>('input[name="other"]')!;
        lookup.addEventListener('input', () => {
          void fetch(`/causality-fixture/lookup?value=${encodeURIComponent(lookup.value)}`);
        });
        other.addEventListener('input', () => {
          void fetch(`/causality-fixture/other?value=${encodeURIComponent(other.value)}`);
        });
      });

      await page.evaluate(() => fetch('/causality-fixture/listing?page=1'));

      const lookup = page.locator('input[name="lookup"]');
      const firstLookup = page.waitForResponse('**/causality-fixture/lookup?value=1');
      await lookup.fill('1');
      await firstLookup;
      const finalLookup = page.waitForResponse('**/causality-fixture/lookup?value=12');
      await lookup.fill('12');
      await finalLookup;
      await lookup.blur();

      await page.waitForTimeout(350);
      await page.evaluate(() => fetch('/causality-fixture/after-blur?value=12'));

      const other = page.locator('input[name="other"]');
      const otherResponse = page.waitForResponse('**/causality-fixture/other?value=B');
      await other.fill('B');
      await otherResponse;
      await other.blur();
      stop();
    },
  });

  const byPath = (path: string) => session.network.find((request) => new URL(request.url).pathname === path);
  const collection = byPath('/causality-fixture/listing');
  const first = session.network.find((request) => request.url.includes('/lookup?value=1'));
  const final = session.network.find((request) => request.url.includes('/lookup?value=12'));
  const afterBlur = byPath('/causality-fixture/after-blur');
  const other = byPath('/causality-fixture/other');

  expect(collection).toMatchObject({ actionIdx: null, causality: 'none', causalityDebug: null });
  expect(first).toMatchObject({ causality: 'active-action' });
  expect(final).toMatchObject({ causality: 'active-action' });
  expect(first?.actionIdx).not.toBeNull();
  expect(final?.actionIdx).toBe(first?.actionIdx);
  expect(session.actions[first!.actionIdx!]).toMatchObject({ type: 'fill', value: '12' });
  expect(final?.causalityDebug).toMatchObject({ kind: 'input', valueAtRequest: '12' });
  expect(afterBlur).toMatchObject({ actionIdx: null, causality: 'none', causalityDebug: null });
  expect(other).toMatchObject({ causality: 'active-action' });
  expect(other?.actionIdx).not.toBe(first?.actionIdx);
  expect(session.actions[other!.actionIdx!]).toMatchObject({ type: 'fill', value: 'B' });
});
