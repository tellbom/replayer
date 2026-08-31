import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordSession } from '@dsh/core';

import { record } from '../packages/recorder/src/session';
import { oaEntry, seedProfile } from './fixture';

test('recording-session: 停止信号后写出完整 RecordSession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-record-session-'));
  const profileDir = join(root, 'profile');
  await seedProfile(profileDir);
  await record({
    entry: oaEntry,
    profileDir,
    outDir: join(root, 'out'),
    channel: 'chrome',
    headless: true,
    stopSignal: new Promise((resolve) => setTimeout(resolve, 500)),
  });
  const stored: RecordSession = JSON.parse(
    await readFile(join(root, 'out', 'record.json'), 'utf8'),
  );

  expect(stored.meta.baseUrl).toBe('http://127.0.0.1:15173');
  expect(stored.meta.startedAt).toBeTruthy();
  expect(stored.meta.endedAt).toBeTruthy();
  expect(stored.meta.userAgent).toContain('Chrome');
  expect(stored.canonicalActions).toEqual([
    expect.objectContaining({
      kind: 'navigate', effects: { navigation: { url: 'http://127.0.0.1:15173/home' } },
    }),
  ]);
  expect(stored.pages).toEqual([
    expect.objectContaining({ url: 'http://127.0.0.1:15173/home' }),
  ]);
  expect(stored.network).toEqual([]);
});
