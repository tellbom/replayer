import { expect, test } from '@playwright/test';
import { readIdentityDigest } from '@dsh/browser';
import { IdentityChangedError, SkillSchema, parseEntry } from '@dsh/core';
import { replay } from '@dsh/replayer';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

test.setTimeout(120_000);

test('T-106 aborts A-to-B reentry before downstream effects and permits A-to-A recovery', async ({ browserName }, testInfo) => {
  let identity = 'account-a';
  let switchTo = 'account-b';
  let interrupted = false;
  let effects = 0;
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    response.setHeader('content-type', 'application/json');
    if (path === '/home') return void response.end('<html><body>home</body></html>');
    if (path === '/probe') return void response.end('{"active":true}');
    if (path === '/identity') return void response.end(JSON.stringify({ principal: identity }));
    if (path === '/interrupt') {
      if (!interrupted) {
        interrupted = true;
        identity = switchTo;
        response.writeHead(401).end('{"ok":false}');
      } else response.end('{"ok":true}');
      return;
    }
    if (path === '/effect') {
      effects += 1;
      return void response.end('{"ok":true}');
    }
    response.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const entry = parseEntry(`
entry:
  id: identity-reentry-fixture
  name: identity reentry fixture
  via: direct
  directUrl: ${baseUrl}/home
  landingUrlPattern: /home
  sessionType: cookie
  sessionProbe: { url: /probe, okStatus: [200] }
  identityProbe: { url: /identity, jsonPath: $.principal, requiresAuth: true }
  sessionHolding: { strategy: daemon, probeIntervalMs: 30000, stateTtlMs: 1800000 }
`);
  const skill = SkillSchema.parse({
    skill: {
      id: 'identity_reentry', name: 'identity reentry', description: 'generic identity fixture',
      system: 'fixture', baseUrl, entry: entry.entry.id, version: 1,
      recordedAt: new Date().toISOString(),
    },
    params: [], preflight: [],
    steps: [
      {
        id: 's1', desc: 'interrupt', channel: 'network', riskLevel: 'read', hasSideEffect: false,
        idempotent: true, network: { method: 'GET', url: '/interrupt', contentType: 'json' },
      },
      {
        id: 's2', desc: 'effect', channel: 'network', riskLevel: 'write', hasSideEffect: true,
        network: { method: 'POST', url: '/effect', contentType: 'json' },
      },
    ],
    assertions: [{ type: 'httpStatus', expect: 200 }],
    verification: { status: 'draft', requiresFirstRunVerification: false, verifiedTtlDays: 30 },
    reentry: { anchor: 's1', maxReentries: 2 },
  });
  const sameIdentitySkill = structuredClone(skill);
  try {
    const digestContext = await chromium.launchPersistentContext(
      testInfo.outputPath(`digest-profile-${browserName}`), { channel: 'chrome', headless: true },
    );
    const digestPage = digestContext.pages()[0] ?? await digestContext.newPage();
    await digestPage.goto(`${baseUrl}/home`);
    const digestA = await readIdentityDigest(digestPage, entry);
    identity = 'account-b';
    const digestB = await readIdentityDigest(digestPage, entry);
    await digestContext.close();
    expect(digestA).not.toBe(digestB);

    identity = 'account-a';
    switchTo = 'account-b';
    interrupted = false;
    effects = 0;
    await expect(replay(skill, {
      params: {}, profileDir: testInfo.outputPath(`changed-profile-${browserName}`), entry,
      noLLM: true, onConfirm: async () => true,
    })).rejects.toBeInstanceOf(IdentityChangedError);
    expect(effects).toBe(0);

    identity = 'account-a';
    switchTo = 'account-a';
    interrupted = false;
    effects = 0;
    const result = await replay(sameIdentitySkill, {
      params: {}, profileDir: testInfo.outputPath(`same-profile-${browserName}`), entry,
      noLLM: true, onConfirm: async () => true,
    });
    expect(result.ok).toBe(true);
    expect(effects).toBe(1);
    testInfo.annotations.push({
      type: 'identity-digests',
      description: `A=${digestA.slice(0, 12)} B=${digestB.slice(0, 12)}`,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
