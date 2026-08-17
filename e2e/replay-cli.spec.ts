import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect, test } from '@playwright/test';
import type { RunResult } from '@dsh/core';

const execFileAsync = promisify(execFile);

test('replay-cli: npm-managed CLI completes the overtime skill', async ({ browserName }, testInfo) => {
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
      testInfo.outputPath(`cli-${browserName}-profile`),
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
