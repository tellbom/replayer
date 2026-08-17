import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';
import type { Skill, Step } from '@dsh/core';
import { chromium } from 'playwright';

import { replay } from '../packages/replayer/src/engine';

const baseUrl = 'http://127.0.0.1:5173';

test('diagnostic: failed step writes eight sanitized artifact types', async ({ browserName }, testInfo) => {
  const secrets = {
    authorization: 'diagnostic-authorization-secret',
    cookie: 'diagnostic-cookie-secret',
    password: 'diagnostic-password-secret',
    token: 'diagnostic-token-secret',
  };
  const profileDir = testInfo.outputPath(`diagnostic-${browserName}-profile`);
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
      baseUrl: `${baseUrl}/login`,
      version: 1,
    },
    params: [],
    preflight: [],
    steps: [
      ...loginSteps(),
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
  };
}

function loginSteps(): Step[] {
  return [
    uiStep('login-user', {
      action: 'fill',
      label: '用户名',
      kind: 'input',
      value: 'tester',
      preAction: { action: 'waitFor', waitFor: { selector: '.el-form-item' } },
    }),
    uiStep('login-password', {
      action: 'fill',
      label: '密码',
      kind: 'input',
      value: 'tester',
    }),
    uiStep('login-submit', {
      action: 'click',
      target: { strategy: 'text', text: '登录' },
      waitFor: { selector: 'a[href="/overtime/apply"]' },
    }),
  ];
}

function uiStep(id: string, ui: NonNullable<Step['ui']>): Step {
  return {
    id,
    desc: id,
    channel: 'ui',
    riskLevel: 'read',
    hasSideEffect: false,
    ui,
  };
}
