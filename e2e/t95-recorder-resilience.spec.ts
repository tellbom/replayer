import { expect, test } from '@playwright/test';
import type { RecordSession } from '@dsh/core';
import { readFile } from 'node:fs/promises';

import { record } from '../packages/recorder/src/session';
import { oaEntry, seedProfile } from './fixture';

test('recording survives a navigation that destroys an in-flight page context', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`navigation-${browserName}`);
  const outDir = testInfo.outputPath('recording');
  await seedProfile(profileDir);
  let finish!: () => void;
  const stopSignal = new Promise<void>((resolve) => { finish = resolve; });

  const session = await record({
    entry: oaEntry,
    profileDir,
    outDir,
    channel: 'chrome',
    headless: true,
    stopSignal,
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/home');
      await page.evaluate(() => {
        const link = document.createElement('a');
        link.textContent = 'Navigate now';
        link.href = '/overtime/apply';
        document.body.append(link);
      });
      await Promise.all([
        page.waitForURL('**/overtime/apply'),
        page.getByRole('link', { name: 'Navigate now' }).click(),
      ]);
      await page.waitForTimeout(500);
      finish();
    },
  });

  expect(session.canonicalActions?.some((action) =>
    action.target?.accessibleName === 'Navigate now' || action.before?.self?.textContent === 'Navigate now',
  )).toBe(true);
  await expect(readFile(`${outDir}/record.json`, 'utf8')).resolves.toContain('Navigate now');
});

test('an abnormal recorder exit preserves an atomic incomplete snapshot', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`partial-${browserName}`);
  const outDir = testInfo.outputPath('recording');
  await seedProfile(profileDir);

  await expect(record({
    entry: oaEntry,
    profileDir,
    outDir,
    channel: 'chrome',
    headless: true,
    stopSignal: new Promise<void>(() => undefined),
    onReady: async (page) => {
      await page.goto('http://127.0.0.1:15173/home');
      await page.evaluate(() => {
        const button = document.createElement('button');
        button.textContent = 'Keep this action';
        document.body.append(button);
        button.click();
      });
      await page.waitForTimeout(200);
      throw new Error('forced-recorder-failure');
    },
  })).rejects.toThrow('forced-recorder-failure');

  const partial = JSON.parse(await readFile(`${outDir}/record.partial.json`, 'utf8')) as
    RecordSession & { incomplete: boolean; reason: string };
  expect(partial.incomplete).toBe(true);
  expect(partial.reason).toContain('forced-recorder-failure');
  expect(partial.canonicalActions?.some((action) =>
    action.target?.accessibleName === 'Keep this action' || action.before?.self?.textContent === 'Keep this action',
  )).toBe(true);
});
