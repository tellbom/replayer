import { expect, test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { parseEntry, parseSkill, type RecordSession } from '@dsh/core';
import { record } from '@dsh/recorder';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const entry = parseEntry(`
entry:
  id: redirect-record-fixture
  name: redirect record fixture
  via: direct
  directUrl: http://localhost:4100/form/apply
  landingUrlPattern: localhost:4100
  excludeUrlPatterns: ['\\?token=']
  sessionType: cookie
  sessionProbe: { url: /api/whoami, okStatus: [200] }
  identityProbe: { url: /api/whoami, jsonPath: $.username, requiresAuth: true }
  loginUrlPatterns: ['/portal/login']
  sessionHolding:
    strategy: daemon
    probeIntervalMs: 30000
    stateTtlMs: 1800000
    cookieKind: session
`);

let fixtures: ChildProcess[] = [];

test.beforeAll(async () => {
  fixtures = [
    spawn(process.execPath, ['server.js'], { cwd: 'apps/mock-portal', stdio: 'ignore' }),
    spawn(process.execPath, ['server.js'], {
      cwd: 'apps/mock-legacy-sys', stdio: 'ignore',
      env: { ...process.env, SUB_COOKIE_MODE: 'persistent' },
    }),
  ];
  await Promise.all([
    waitForHttp('http://localhost:4000/portal/login'),
    waitForHttp('http://localhost:4100/_debug/state'),
  ]);
});

test.afterAll(() => {
  for (const fixture of fixtures) fixture.kill();
});

test('T-102 records a native form redirect and produces a guarded page-scoped draft', async () => {
  test.setTimeout(60_000);
  const root = await mkdtemp(join(tmpdir(), 'dsh-t102-record-'));
  const profileDir = join(root, 'profile');
  const outDir = join(root, 'out');
  const seed = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: true });
  try {
    const page = seed.pages()[0] ?? await seed.newPage();
    await page.goto('http://localhost:4000/portal/login');
    await page.locator('#fp-btn').click();
    await page.waitForURL('**/portal');
    await page.locator('a[href="/portal/jump/legacy"]').click();
    await page.waitForURL('http://localhost:4100/home');
    const subCookie = (await seed.cookies('http://localhost:4100'))
      .find((cookie) => cookie.name === 'JSESSIONID');
    if (!subCookie) throw new Error('fixture did not establish a subsystem session');
    await seed.addCookies([{ ...subCookie, expires: Math.floor(Date.now() / 1_000) + 3_600 }]);
  } finally {
    await seed.close();
  }

  let stop!: () => void;
  const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
  await record({
    entry, profileDir, outDir, headless: true, stopSignal,
    onReady: async (page) => {
      await page.goto('http://localhost:4100/form/apply');
      await page.locator('#deviceType').selectOption('LAPTOP');
      await page.locator('input[name="urgency"][value="URGENT"]').check();
      await page.locator('#desc').fill('redirect-record-marker');
      await page.locator('input[name="parts"][value="BATTERY"]').check();
      await page.locator('#applyForm .submitBtn_a1b2c_').click();
      await page.waitForURL('http://localhost:4100/records');
      const recordsResponse = page.waitForResponse((response) => response.url().includes('/api/records'));
      await page.evaluate(() => fetch('/api/records?limit=20', { credentials: 'include' }));
      await recordsResponse;
      stop();
    },
  });

  const session: RecordSession = JSON.parse(await readFile(join(outDir, 'record.json'), 'utf8'));
  const submission = session.network.find((request) => request.url.includes('/form/apply/submit'));
  expect(submission).toMatchObject({ method: 'POST', resourceType: 'document', mutating: true });
  expect(session.pages.some((page) => page.url.endsWith('/records'))).toBe(true);

  const draft = generateDraft(session);
  const redirectStep = draft.skill.steps.find((step) => step.expectsRedirect);
  expect(redirectStep).toBeDefined();
  expect(draft.skill.postcondition?.request.url).toContain('/api/records');
  expect(draft.skill.preflight).toEqual([]);
  const pageExtracts = JSON.stringify(draft.skill.steps.map((step) => step.ui?.extract));
  expect(pageExtracts).toContain('__VIEWSTATE');
  expect(pageExtracts).toContain('__TOKEN');
  expect(pageExtracts).toContain('seqCode');
  expect(() => parseSkill(draft.yaml, () => entry)).not.toThrow();
});

async function waitForHttp(url: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw lastError ?? new Error(`fixture unavailable: ${url}`);
}
