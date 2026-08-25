import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { chromium } from 'playwright';

import { acquireDSHContext } from '../packages/browser/src/context.js';
import { login } from './helpers.js';

test('T-76: CDP 附着共享 session cookie，释放租约不关闭 daemon context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-t76-profile-'));
  const port = await reservePort();
  const owner = await chromium.launchPersistentContext(root, {
    channel: 'chrome',
    headless: true,
    args: [`--remote-debugging-port=${port}`],
  });
  try {
    const ownerPage = owner.pages()[0] ?? (await owner.newPage());
    await login(ownerPage);
    expect(await ownerPage.evaluate(() => typeof Reflect.get(window, '__DSH_LOCATOR__'))).toBe('undefined');

    const unavailablePort = await reservePort();
    await expect(acquireDSHContext(
      { profileDir: root },
      `http://127.0.0.1:${unavailablePort}`,
    )).rejects.toThrow('未关闭现有浏览器');
    await expect(ownerPage.title()).resolves.toBeTruthy();

    const lease = await acquireDSHContext(
      { profileDir: root },
      `http://127.0.0.1:${port}`,
    );
    const attachedPage = lease.context.pages().find((page) => page.url().includes('/home'))!;
    expect(await attachedPage.evaluate(() => ({
      locator: typeof Reflect.get(window, '__DSH_LOCATOR__'),
      snapshot: typeof Reflect.get(window, '__DSH_SNAPSHOT__'),
      mutation: typeof Reflect.get(window, '__DSH_MUTATION__'),
      ancestorScope: typeof Reflect.get(window, '__DSH_ANCESTOR_SCOPE__'),
    }))).toEqual({
      locator: 'object', snapshot: 'function', mutation: 'object', ancestorScope: 'function',
    });
    const futurePage = await lease.context.newPage();
    await futurePage.setContent('<main>future page</main>');
    expect(await futurePage.evaluate(() => typeof Reflect.get(window, '__DSH_LOCATOR__'))).toBe('object');
    await futurePage.close();
    const session = await attachedPage.evaluate(() =>
      fetch('/api/session?_nodelay=1', { credentials: 'include' }).then((response) => response.json()),
    );
    expect(session).toEqual({ loggedIn: true, user: 'tester' });

    await lease.release();
    await expect(
      ownerPage.evaluate(() =>
        fetch('/api/session?_nodelay=1', { credentials: 'include' }).then((response) => response.json()),
      ),
    ).resolves.toEqual({ loggedIn: true, user: 'tester' });

    for (let index = 0; index < 2; index += 1) {
      const reused = await acquireDSHContext(
        { profileDir: root },
        `http://127.0.0.1:${port}`,
      );
      const reusedPage = reused.context.pages().find((page) => page.url().includes('/home'))!;
      await expect(reusedPage.evaluate(() =>
        fetch('/api/session?_nodelay=1', { credentials: 'include' }).then((response) => response.json()),
      )).resolves.toEqual({ loggedIn: true, user: 'tester' });
      await reused.release();
    }
  } finally {
    await owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
