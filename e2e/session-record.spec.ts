import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RecordSession } from '@dsh/core';

import { record } from '../packages/recorder/src/session';

test('recording-session: 停止信号后写出完整 RecordSession', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-record-session-'));
  await record({
    url: 'http://127.0.0.1:5173/login',
    profileDir: join(root, 'profile'),
    outDir: join(root, 'out'),
    channel: 'chrome',
    headless: true,
    stopSignal: new Promise((resolve) => setTimeout(resolve, 500)),
  });
  const stored: RecordSession = JSON.parse(
    await readFile(join(root, 'out', 'record.json'), 'utf8'),
  );

  expect(stored.meta.baseUrl).toBe('http://127.0.0.1:5173');
  expect(stored.meta.startedAt).toBeTruthy();
  expect(stored.meta.endedAt).toBeTruthy();
  expect(stored.meta.userAgent).toContain('Chrome');
  expect(stored.actions).toEqual([
    expect.objectContaining({ type: 'navigate', url: 'http://127.0.0.1:5173/login' }),
  ]);
  expect(stored.pages).toEqual([
    expect.objectContaining({ url: 'http://127.0.0.1:5173/login' }),
  ]);
  expect(stored.network).toEqual([]);
});
