import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { launchDSHContext } from './context.js';

const profiles: string[] = [];

afterEach(async () => {
  for (const profile of profiles.splice(0)) await rm(profile, { recursive: true, force: true });
});

describe('T-17 Playwright 持久化上下文', () => {
  it('为新页面注入单一 Playwright Locator Engine', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'dsh-browser-test-'));
    profiles.push(profileDir);
    const context = await launchDSHContext({ profileDir, headless: true });
    try {
      const page = await context.newPage();
      await page.goto('data:text/html,<h1>test</h1>');
      const globals = await page.evaluate(() => ({
        locator: typeof Reflect.get(window, '__DSH_LOCATOR__'),
        snapshot: typeof Reflect.get(window, '__DSH_SNAPSHOT__'),
        generator: typeof Reflect.get(window, '__DSH_PWGEN__'),
        mutation: typeof Reflect.get(window, '__DSH_MUTATION__'),
        ancestorScope: typeof Reflect.get(window, '__DSH_ANCESTOR_SCOPE__'),
      }));
      expect(globals).toEqual({
        locator: 'object',
        snapshot: 'function',
        generator: 'function',
        mutation: 'object',
        ancestorScope: 'function',
      });
    } finally {
      await context.close();
    }
  }, 15_000);
});
