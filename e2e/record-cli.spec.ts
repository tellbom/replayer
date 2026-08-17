import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('record-cli: 命令行停止后产出 record.json', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-record-cli-'));
  const child = spawn(
    process.execPath,
    [
      'packages/cli/dist/index.js',
      'record',
      '--url',
      'http://127.0.0.1:5173/login',
      '--out',
      join(root, 'out'),
      '--profile',
      join(root, 'profile'),
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
  expect(stored.actions).toEqual([expect.objectContaining({ type: 'navigate' })]);
});
