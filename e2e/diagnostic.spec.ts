import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import { SkillVerificationSchema } from '@dsh/core';
import type { Skill } from '@dsh/core';
import { chromium } from 'playwright';

import { replay } from '../packages/replayer/src/engine';
import { oaEntry, seedProfile } from './fixture';

const baseUrl = 'http://127.0.0.1:15173';

test('diagnostic: failed step writes eight sanitized artifact types', async ({ browserName }, testInfo) => {
  const secrets = {
    authorization: 'diagnostic-authorization-secret',
    cookie: 'diagnostic-cookie-secret',
    password: 'diagnostic-password-secret',
    token: 'diagnostic-token-secret',
  };
  const profileDir = testInfo.outputPath(`diagnostic-${browserName}-profile`);
  await seedProfile(profileDir);
  const seedContext = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: true,
  });
  await seedContext.addCookies([
    {
      name: 'diagnostic_cookie',
      value: secrets.cookie,
      url: baseUrl,
      expires: Math.floor(Date.now() / 1_000) + 3_600,
    },
  ]);
  await seedContext.close();

  const result = await replay(failingSkill(secrets), {
    params: {},
    profileDir,
    entry: oaEntry,
    noLLM: true,
  });

  expect(result.ok).toBe(false);
  expect(result.diagnosticDir).toBeTruthy();
  const directory = result.diagnosticDir!;
  const files = await readdir(directory);
  expect(files.sort()).toEqual(
    [
      'console.log',
      'llm-trace.jsonl',
      'network.har',
      'result.json',
      'step-fail-after.png',
      'step-fail-before.png',
      'step-fail-dom.html',
      'step-fail-snapshot.txt',
    ].sort(),
  );

  const text = (
    await Promise.all(
      files
        .filter((file) => !file.endsWith('.png'))
        .map((file) => readFile(join(directory, file), 'utf8')),
    )
  ).join('\n');
  for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
  expect(text).toContain('<REDACTED:sha256:');
});

function failingSkill(secrets: Record<string, string>): Skill {
  return {
    skill: {
      id: 'diagnostic-failure',
      name: 'diagnostic failure',
      system: 'mock-oa',
      baseUrl,
      entry: 'oa',
      version: 1,
    },
    params: [],
    preflight: [],
    steps: [
      {
        id: 'fail',
        desc: 'intentional failure',
        channel: 'network',
        riskLevel: 'read',
        hasSideEffect: false,
        network: {
          method: 'POST',
          url: `/api/not-found?token=${secrets.token}`,
          headers: {
            authorization: `Bearer ${secrets.authorization}`,
            'x-api-key': secrets.token,
          },
          contentType: 'json',
          body: { password: secrets.password, token: secrets.token },
        },
      },
    ],
    assertions: [],
    verification: SkillVerificationSchema.parse({}),
  };
}
