import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify } from 'yaml';

import { oaEntry, seedProfile } from './fixture';

test('record-cli: 命令行停止后产出 record.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-record-cli-'));
  const profileDir = join(root, 'profile');
  const entriesDir = join(root, 'entries');
  await seedProfile(profileDir);
  await mkdir(entriesDir, { recursive: true });
  await writeFile(
    join(entriesDir, 'oa.yaml'),
    stringify({
      ...oaEntry,
      entry: {
        ...oaEntry.entry,
        sessionHolding: { ...oaEntry.entry.sessionHolding, strategy: 'probe-only' },
      },
    }),
    'utf8',
  );
  const child = spawn(
    process.execPath,
    [
      'packages/cli/dist/index.js',
      'record',
      '--entry',
      'oa',
      '--entries',
      entriesDir,
      '--out',
      join(root, 'out'),
      '--profile',
      profileDir,
      '--channel',
      'chrome',
    ],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const output = await new Promise<string>((resolve, reject) => {
    let text = '';
    let stopSent = false;
    child.stdout.on('data', (chunk: Buffer) => {
      text += chunk.toString();
      if (!stopSent && text.includes('按 Enter 结束录制')) {
        stopSent = true;
        child.stdin.end('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve(text);
      else reject(new Error(`dsh record 退出码 ${code}\n${text}`));
    });
  });

  expect(output).toContain('录制已写入');
  const stored = JSON.parse(await readFile(join(root, 'out', 'record.json'), 'utf8'));
  expect(stored.actions).toEqual([]);
  expect(stored.canonicalActions).toEqual([expect.objectContaining({ kind: 'navigate' })]);
});
