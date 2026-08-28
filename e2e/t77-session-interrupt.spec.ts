import { expect, test } from '@playwright/test';
import type { Entry, RecordSession } from '@dsh/core';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserContext } from 'playwright';

import { launchDSHContext } from '../packages/browser/src/context.js';
import { record } from '../packages/recorder/src/session.js';
import { login } from './helpers.js';

test('T-77: session 与 persistent cookie 的浏览器属性符合契约', async () => {
  test.setTimeout(60_000);
  const testTmp = resolve('tmp');
  await mkdir(testTmp, { recursive: true });
  const sessionProfile = await mkdtemp(join(testTmp, 'dsh-t77-session-'));
  const persistentProfile = await mkdtemp(join(testTmp, 'dsh-t77-persistent-'));
  let context = await launchDSHContext({
    profileDir: sessionProfile,
    channel: 'chrome',
    headless: true,
  });
  await login(context.pages()[0] ?? (await context.newPage()));
  expect((await context.cookies()).find((cookie) => cookie.name === 'MOCK_OA_SID')?.expires).toBe(
    -1,
  );
  await closePersistentContext(context);
  context = await launchDSHContext({
    profileDir: sessionProfile,
    channel: 'chrome',
    headless: true,
  });
  let page = context.pages()[0] ?? (await context.newPage());
  await page.goto('http://127.0.0.1:15173/home');
  await expect(
    page.evaluate(() => fetch('/api/session?_nodelay=1').then((response) => response.json())),
  ).resolves.toEqual({ loggedIn: false });
  await closePersistentContext(context);

  context = await launchDSHContext({
    profileDir: persistentProfile,
    channel: 'chrome',
    headless: true,
  });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto('http://127.0.0.1:15173/login');
  await page.evaluate(() =>
    fetch('/api/login?cookieMode=persistent&_nodelay=1', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'tester' }),
    }),
  );
  expect(
    (await context.cookies()).find((cookie) => cookie.name === 'MOCK_OA_SID')!.expires,
  ).toBeGreaterThan(0);
  await closePersistentContext(context);
  context = await launchDSHContext({
    profileDir: persistentProfile,
    channel: 'chrome',
    headless: true,
  });
  page = context.pages()[0] ?? (await context.newPage());
  await page.goto('http://127.0.0.1:15173/home');
  await expect(
    page.evaluate(() => fetch('/api/session?_nodelay=1').then((response) => response.json())),
  ).resolves.toEqual({ loggedIn: true, user: 'tester' });
});

test('T-77: 同身份登录后续录，登录动作不入库且断点后 scope 重建', async () => {
  test.setTimeout(90_000);
  const fixture = await residentFixture();
  try {
    let finish!: () => void;
    const stopSignal = new Promise<void>((resolveStop) => {
      finish = resolveStop;
    });
    let scenario!: Promise<void>;
    const session = await record({
      recorderPath: 'legacy',
      entry: entry(),
      profileDir: fixture.profile,
      outDir: fixture.out,
      headless: true,
      cdpEndpoint: fixture.endpoint,
      stopSignal,
      onReady: async (page) => {
        scenario = (async () => {
          expect(await page.evaluate(() => window.__DSH_RECORDING__)).toBe(true);
          await page.evaluate(() => {
            for (let index = 1; index <= 7; index += 1) {
              const button = document.createElement('button');
              button.textContent = `中断前动作${index}`;
              document.body.append(button);
            }
          });
          for (let index = 1; index <= 7; index += 1) {
            await page.evaluate((name) => {
              const button = [...document.querySelectorAll('button')].find(
                (candidate) => candidate.textContent === name,
              );
              if (!(button instanceof HTMLButtonElement)) throw new Error(`按钮不存在: ${name}`);
              button.click();
            }, `中断前动作${index}`);
            await expect
              .poll(() => page.evaluate(() => Object.keys(window.__dsh_clicked__ ?? {}).length))
              .toBe(index);
          }
          await page.evaluate(() =>
            fetch('/api/_debug/expire?portal=1&_nodelay=1', { method: 'POST' }),
          );
          await expect(page.getByText('会话已过期，请重新登录')).toBeVisible({ timeout: 15_000 });
          await expect(page.locator('#__dsh_login_hint__')).toBeVisible();
          await page.goto('http://127.0.0.1:15173/login');
          await page.getByLabel('用户名').fill('tester');
          await page.getByLabel('密码').fill('tester');
          const loginResult = await page.evaluate(() =>
            fetch('/api/login?_nodelay=1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: 'tester', password: 'tester' }),
            }).then((response) => response.json()),
          );
          expect(loginResult).toMatchObject({ loggedIn: true, user: 'tester' });
          await expect
            .poll(() =>
              page.evaluate(() =>
                fetch('/api/session?_nodelay=1').then((response) => response.json()),
              ),
            )
            .toMatchObject({ loggedIn: true, user: 'tester' });
          await expect(page.getByText('会话已恢复')).toBeVisible({ timeout: 30_000 });
          expect(await page.evaluate(() => window.__DSH_RECORDING__)).toBe(true);
          await page.evaluate(() => {
            const button = document.createElement('button');
            button.textContent = '续录动作';
            document.body.append(button);
          });
          await page.evaluate(() => {
            const button = [...document.querySelectorAll('button')].find(
              (candidate) => candidate.textContent === '续录动作',
            );
            if (!(button instanceof HTMLButtonElement)) throw new Error('续录按钮不存在');
            button.click();
          });
          await page.waitForTimeout(2_000);
          expect(await page.evaluate(() => Object.keys(window.__dsh_clicked__ ?? {}).length)).toBe(
            1,
          );
          finish();
        })();
      },
    });
    await scenario;

    expect(session.interruptions).toHaveLength(1);
    expect(session.interruptions?.[0]?.resumedAt).toBeTruthy();
    expect(session.interruptions?.[0]?.atActionIdx).toBeGreaterThanOrEqual(8);
    expect(session.meta.identityChanged).toBeUndefined();
    expect(session.actions.some((action) => action.text === '中断前动作7')).toBe(true);
    expect(session.actions.some((action) => action.text === '续录动作')).toBe(true);
    expect(
      session.actions.some((action) => action.value === 'tester' || action.text === '登录'),
    ).toBe(false);
    expect(session.network.some((request) => request.url.includes('/api/login'))).toBe(false);
    await expect(readFile(join(fixture.out, 'record.partial.json'), 'utf8')).rejects.toThrow();
  } finally {
    await fixture.close();
  }
});

test('T-77: 换身份登录立即中止并保留 partial 录制', async () => {
  test.setTimeout(60_000);
  const fixture = await residentFixture();
  try {
    let scenario!: Promise<void>;
    const session = await record({
      recorderPath: 'legacy',
      entry: entry(),
      profileDir: fixture.profile,
      outDir: fixture.out,
      headless: true,
      cdpEndpoint: fixture.endpoint,
      stopSignal: new Promise<void>(() => undefined),
      onReady: async (page) => {
        scenario = (async () => {
          expect(await page.evaluate(() => window.__DSH_RECORDING__)).toBe(true);
          await page.evaluate(() => {
            for (let index = 1; index <= 7; index += 1) {
              const button = document.createElement('button');
              button.textContent = `应保留动作${index}`;
              document.body.append(button);
            }
          });
          for (let index = 1; index <= 7; index += 1) {
            await page.evaluate((name) => {
              const button = [...document.querySelectorAll('button')].find(
                (candidate) => candidate.textContent === name,
              );
              if (!(button instanceof HTMLButtonElement)) throw new Error(`按钮不存在: ${name}`);
              button.click();
            }, `应保留动作${index}`);
            await expect
              .poll(() => page.evaluate(() => Object.keys(window.__dsh_clicked__ ?? {}).length))
              .toBe(index);
          }
          await page.evaluate(() =>
            fetch('/api/_debug/expire?portal=1&_nodelay=1', { method: 'POST' }),
          );
          await expect(page.getByText('会话已过期，请重新登录')).toBeVisible({ timeout: 15_000 });
          await expect(page.locator('#__dsh_login_hint__')).toBeVisible();
          await page.goto('http://127.0.0.1:15173/login');
          await page.getByLabel('用户名').fill('other-user');
          await page.getByLabel('密码').fill('other-user');
          const loginResult = await page.evaluate(() =>
            fetch('/api/login?_nodelay=1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: 'other-user', password: 'other-user' }),
            }).then((response) => response.json()),
          );
          expect(loginResult).toMatchObject({ loggedIn: true, user: 'other-user' });
        })();
      },
    });
    await scenario;

    expect(session.meta.identityChanged).toBe(true);
    expect(session.interruptions?.[0]).toMatchObject({ identityChanged: true });
    expect(session.actions.some((action) => action.text === '应保留动作7')).toBe(true);
    expect(
      session.actions.some((action) => action.value === 'other-user' || action.text === '登录'),
    ).toBe(false);
    const partial = JSON.parse(
      await readFile(join(fixture.out, 'record.partial.json'), 'utf8'),
    ) as RecordSession;
    expect(partial.meta.identityChanged).toBe(true);
  } finally {
    await fixture.close();
  }
});

function entry(): Entry {
  return {
    entry: {
      id: 'oa',
      name: 'Mock OA',
      via: 'direct',
      directUrl: 'http://127.0.0.1:15173/home',
      landingUrlPattern: '/home',
      excludeUrlPatterns: ['\\?token=', '/sso/redirect'],
      sessionType: 'cookie',
      sessionProbe: { url: '/api/session?_nodelay=1', jsonPath: '$.loggedIn', okStatus: [200] },
      identityProbe: { url: '/api/userinfo?_nodelay=1', jsonPath: '$.sub', requiresAuth: true },
      loginUrlPatterns: ['/login'],
      loginDomMarkers: ['input[type="password"]'],
      loginTimeoutMs: 20_000,
      sessionHolding: {
        strategy: 'daemon',
        probeIntervalMs: 10_000,
        stateTtlMs: 1_800_000,
        cookieKind: 'session',
      },
      credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
    },
  };
}

async function residentFixture(): Promise<{
  profile: string;
  out: string;
  endpoint: string;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-t77-record-'));
  const port = await reservePort();
  const owner = await launchDSHContext({
    profileDir: join(root, 'profile'),
    channel: 'chrome',
    headless: true,
    args: [`--remote-debugging-port=${port}`],
  });
  await login(owner.pages()[0] ?? (await owner.newPage()));
  return {
    profile: join(root, 'profile'),
    out: join(root, 'out'),
    endpoint: `http://127.0.0.1:${port}`,
    async close() {
      await owner.close();
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    },
  };
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配端口');
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function closePersistentContext(context: BrowserContext): Promise<void> {
  await Promise.all(context.pages().map((page) => page.close()));
  await context.close();
}
