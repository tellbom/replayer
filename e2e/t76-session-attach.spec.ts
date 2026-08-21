import { expect, test } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { acquireDSHContext, launchDSHContext } from '../packages/browser/src/context.js';
import { login } from './helpers.js';

test('T-76: CDP 附着共享 session cookie，释放租约不关闭 daemon context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-t76-profile-'));
  const port = await reservePort();
  const owner = await launchDSHContext({
    profileDir: root,
    channel: 'chrome',
    headless: true,
    args: [`--remote-debugging-port=${port}`],
  });
  try {
    const ownerPage = owner.pages()[0] ?? (await owner.newPage());
    await login(ownerPage);

    const lease = await acquireDSHContext(
      { profileDir: root },
      `http://127.0.0.1:${port}`,
    );
    const attachedPage = lease.context.pages().find((page) => page.url().includes('/home'))!;
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
