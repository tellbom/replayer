import {
  ensureEntry,
  launchDSHContext,
  probeEntryAuthState,
  readIdentityDigest,
  type SessionState,
} from '@dsh/browser';
import { parseEntry } from '@dsh/core';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname } from 'node:path';

interface DaemonOptions {
  entryPath: string;
  profileDir: string;
  statePath: string;
  channel: 'chrome' | 'msedge';
}

export async function runSessionDaemon(options: DaemonOptions): Promise<void> {
  const entry = parseEntry(await readFile(options.entryPath, 'utf8'));
  const port = await reservePort();
  const context = await launchDSHContext({
    profileDir: options.profileDir,
    channel: options.channel,
    headless: false,
    args: [`--remote-debugging-port=${port}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const baseState: SessionState = {
    entryId: entry.entry.id,
    pid: process.pid,
    endpoint: `http://127.0.0.1:${port}`,
    profileDir: options.profileDir,
    status: 'starting',
    pageUrl: page.url(),
  };
  await writeState(options.statePath, baseState);

  let session: Awaited<ReturnType<typeof ensureEntry>>;
  try {
    session = await ensureEntry(page, entry);
  } catch (error) {
    await writeState(options.statePath, {
      ...baseState,
      status: 'invalid',
      lastProbeAt: new Date().toISOString(),
      pageUrl: page.url(),
    });
    await context.close();
    throw error;
  }
  let state: SessionState = {
    ...baseState,
    status: 'active',
    identityDigest: session.identityDigest,
    lastProbeAt: new Date().toISOString(),
    sessionEstablishedAt: new Date().toISOString(),
    pageUrl: page.url(),
  };
  await writeState(options.statePath, state);
  await updateExpiryReminder(page, entry, state).catch(() => undefined);

  let probing = false;
  const timer = setInterval(() => {
    if (probing) return;
    probing = true;
    void (async () => {
      const authState = await probeEntryAuthState(page, entry);
      if (authState !== 'authenticated' && authState !== 'forbidden') {
        state = {
          ...state,
          status: 'starting',
          lastProbeAt: new Date().toISOString(),
          pageUrl: page.url(),
        };
        await writeState(options.statePath, state);
        const recovered = await ensureEntry(page, entry);
        state = {
          ...state,
          status: 'active',
          identityDigest: recovered.identityDigest,
          lastProbeAt: new Date().toISOString(),
          sessionEstablishedAt: new Date().toISOString(),
          pageUrl: page.url(),
        };
        await writeState(options.statePath, state);
        await updateExpiryReminder(page, entry, state).catch(() => undefined);
        return;
      }
      const valid = authState === 'authenticated';
      state = {
        ...state,
        status: valid ? 'active' : 'invalid',
        lastProbeAt: new Date().toISOString(),
        pageUrl: page.url(),
        ...(valid ? { identityDigest: await readIdentityDigest(page, entry) } : {}),
      };
      await writeState(options.statePath, state);
      await updateExpiryReminder(page, entry, state).catch(() => undefined);
      if (!valid) await page.bringToFront();
    })()
      .catch(async () => {
        state = {
          ...state,
          status: 'invalid',
          lastProbeAt: new Date().toISOString(),
          pageUrl: page.url(),
        };
        await writeState(options.statePath, state);
      })
      .finally(() => {
        probing = false;
      });
  }, entry.entry.sessionHolding.probeIntervalMs);

  await new Promise<void>((resolveStop) => {
    const stop = (): void => resolveStop();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  clearInterval(timer);
  await context.close();
  await rm(options.statePath, { force: true });
}

async function updateExpiryReminder(page: import('playwright').Page, entry: ReturnType<typeof parseEntry>, state: SessionState): Promise<void> {
  const expected = entry.entry.sessionHolding.expectedPortalTtlMs;
  const warnBefore = entry.entry.sessionHolding.warnBeforeExpiryMs;
  const established = state.sessionEstablishedAt ? Date.parse(state.sessionEstablishedAt) : Number.NaN;
  if (expected === undefined || warnBefore === undefined || !Number.isFinite(established)) {
    await page.evaluate(() => document.querySelector('#__dsh_session_expiry_hint__')?.remove());
    return;
  }
  const remaining = established + expected - Date.now();
  if (remaining > warnBefore) {
    await page.evaluate(() => document.querySelector('#__dsh_session_expiry_hint__')?.remove());
    return;
  }
  const minutes = Math.max(0, Math.ceil(remaining / 60_000));
  await page.evaluate((value) => {
    let hint = document.querySelector('#__dsh_session_expiry_hint__');
    if (!hint) {
      hint = document.createElement('div');
      hint.id = '__dsh_session_expiry_hint__';
      Object.assign((hint as HTMLElement).style, {
        position: 'fixed', inset: 'auto 12px 12px auto', zIndex: '2147483647',
        padding: '10px 14px', color: 'white', background: '#ad6800',
      });
      (document.body ?? document.documentElement).append(hint);
    }
    hint.textContent = value > 0
      ? `DSH：会话配置 TTL 预计约 ${value} 分钟后到达，请在长流程前重新认证`
      : 'DSH：会话配置 TTL 预计时长已耗尽；实际状态仍以实时探测为准';
  }, minutes);
}

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 CDP 端口');
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return address.port;
}

async function writeState(path: string, state: SessionState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

if (process.argv[1]?.endsWith('session-daemon.js')) {
  const values = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    values.set(process.argv[index]!.slice(2), process.argv[index + 1]!);
  }
  await runSessionDaemon({
    entryPath: values.get('entry-path')!,
    profileDir: values.get('profile')!,
    statePath: values.get('state')!,
    channel: values.get('channel') === 'msedge' ? 'msedge' : 'chrome',
  });
}
