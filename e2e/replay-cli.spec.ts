import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';

import { expect, test } from '@playwright/test';
import type { RunResult } from '@dsh/core';
import { stringify } from 'yaml';

import { oaEntry, seedProfile } from './fixture';

const execFileAsync = promisify(execFile);

test('replay-cli: npm-managed CLI completes the overtime skill', async ({ browserName }, testInfo) => {
  const profileDir = testInfo.outputPath(`cli-${browserName}-profile`);
  const entriesDir = testInfo.outputPath('entries');
  await seedProfile(profileDir);
  await writeProbeOnlyEntry(entriesDir);
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      'packages/cli/dist/index.js',
      'replay',
      'skills/oa_overtime_submit.yaml',
      '--params',
      JSON.stringify({
        type: '工作日加班',
        startTime: '2026-08-18 18:00',
        endTime: '2026-08-18 21:00',
        reason: '版本上线',
      }),
      '--profile',
      profileDir,
      '--entries',
      entriesDir,
      '--no-llm',
      '--yes',
    ],
    { cwd: process.cwd(), timeout: 60_000 },
  );
  const result = JSON.parse(stdout) as RunResult;
  const submit = result.steps.at(-1);

  expect(result.ok).toBe(true);
  expect(result.extracted).toMatchObject({
    startTime: '2026-08-18 18:00',
    endTime: '2026-08-18 21:00',
    reason: '版本上线',
  });
  expect(submit).toMatchObject({
    stepId: 'submit',
    outcome: 'confirmed_success',
    channelUsed: 'network',
    raw: { status: 200 },
  });
  expect(JSON.parse(submit?.raw?.text ?? '{}')).toMatchObject({ code: 0, no: expect.any(String) });
});

async function writeProbeOnlyEntry(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    `${directory}/oa.yaml`,
    stringify({
      ...oaEntry,
      entry: {
        ...oaEntry.entry,
        sessionHolding: { ...oaEntry.entry.sessionHolding, strategy: 'probe-only' },
      },
    }),
    'utf8',
  );
}
