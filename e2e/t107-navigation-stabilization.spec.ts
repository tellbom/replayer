import { expect, test } from '@playwright/test';
import {
  NavigationStabilizationError,
  settleNavigation,
} from '@dsh/browser';

test('V-107-1/V-107-5: no-redirect cold and attached pages are not classified by session type', async ({ page }) => {
  for (const observedFixture of ['bearer', 'cookie', 'mixed']) {
    await settleNavigation(
      page,
      () => page.goto(`data:text/html,<title>${observedFixture}</title><main>ready</main>`),
    );
    await expect(page.locator('main')).toHaveText('ready');
  }

  await settleNavigation(page);
  await expect(page.locator('main')).toHaveText('ready');
});

test('V-107-2/V-107-3: multi-hop navigation settles before downstream probing', async ({ page }) => {
  await page.route('http://navigation.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const next = pathname === '/start' ? '/middle' : pathname === '/middle' ? '/landing' : null;
    await route.fulfill({
      contentType: 'text/html',
      body: next
        ? `<script>setTimeout(() => location.href = '${next}', 100)</script>`
        : '<main data-session="valid">landing</main>',
    });
  });

  await settleNavigation(page, () => page.goto('http://navigation.test/start'));
  const probe = await page.locator('main').getAttribute('data-session');

  expect(page.url()).toBe('http://navigation.test/landing');
  expect(probe).toBe('valid');
});

test('V-107-4: a non-converging lifecycle fails with observed states and attached-session guidance', async ({ page }) => {
  await page.route('http://unstable.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const next = pathname === '/a' ? '/b' : '/a';
    await route.fulfill({
      contentType: 'text/html',
      body: `<script>setTimeout(() => location.href = '${next}', 50)</script>`,
    });
  });

  const error = await settleNavigation(
    page,
    () => page.goto('http://unstable.test/a'),
    900,
  ).catch((cause: unknown) => cause);

  expect(error).toBeInstanceOf(NavigationStabilizationError);
  expect((error as NavigationStabilizationError).observedStates.length).toBeGreaterThan(1);
  expect(String(error)).toContain('persistent / attached session');
});
