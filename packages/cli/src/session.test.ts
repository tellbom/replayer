import type { Entry } from '@dsh/core';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveSessionEndpoint, statusSession } from './session.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('T-76 会话策略', () => {
  it('daemon 只附着 active 的存活进程', async () => {
    const root = await stateDir({ status: 'active', pid: process.pid });
    await expect(resolveSessionEndpoint(entry('daemon'), root)).resolves.toBe('http://127.0.0.1:9222');
  });

  it('进程已退出时如实拒绝', async () => {
    const root = await stateDir({ status: 'active', pid: 2_147_483_647 });
    await expect(resolveSessionEndpoint(entry('daemon'), root)).resolves.toBeUndefined();
    await expect(access(join(root, 'session-oa.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('无 state 时回落为自行启动，显式 force-takeover 才关闭已知 owner', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'dsh-session-empty-'));
    roots.push(empty);
    await expect(resolveSessionEndpoint(entry('daemon'), empty)).resolves.toBeUndefined();

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    await new Promise<void>((resolveReady) => child.once('spawn', resolveReady));
    const root = await stateDir({ status: 'active', pid: child.pid! });
    await expect(resolveSessionEndpoint(entry('daemon'), root, true)).resolves.toBeUndefined();
    await expect(access(join(root, 'session-oa.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('仅按 entry 配置阈值输出 TTL 提醒，缺少配置时不提醒', async () => {
    const root = await stateDir({
      status: 'active', pid: process.pid,
      sessionEstablishedAt: new Date(Date.now() - 80_000).toISOString(),
    });
    const configured = entry('daemon');
    configured.entry.sessionHolding.expectedPortalTtlMs = 100_000;
    configured.entry.sessionHolding.warnBeforeExpiryMs = 30_000;
    await writeFile(join(root, 'oa.yaml'), JSON.stringify(configured), 'utf8');
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    await statusSession({ entry: 'oa', entries: root, stateDir: root });
    expect(output.mock.calls.flat().join('')).toContain('请在长流程前重新认证');

    delete configured.entry.sessionHolding.warnBeforeExpiryMs;
    await writeFile(join(root, 'oa.yaml'), JSON.stringify(configured), 'utf8');
    output.mockClear();
    await statusSession({ entry: 'oa', entries: root, stateDir: root });
    expect(output.mock.calls.flat().join('')).not.toContain('请在长流程前重新认证');
  });

  it('invalid 会话不得被录制或回放复用', async () => {
    const root = await stateDir({ status: 'invalid', pid: process.pid });
    await expect(resolveSessionEndpoint(entry('daemon'), root)).rejects.toThrow('状态为 invalid');
  });

  it('probe-only 独立启动，storage-state 未启用时明确拒绝', async () => {
    await expect(resolveSessionEndpoint(entry('probe-only'), '.')).resolves.toBeUndefined();
    await expect(resolveSessionEndpoint(entry('storage-state'), '.')).rejects.toThrow('T-78 尚未启用');
  });
});

async function stateDir(overrides: {
  status: 'active' | 'invalid';
  pid: number;
  sessionEstablishedAt?: string;
}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-state-'));
  roots.push(root);
  await writeFile(
    join(root, 'session-oa.json'),
    JSON.stringify({
      entryId: 'oa',
      endpoint: 'http://127.0.0.1:9222',
      profileDir: 'profile',
      ...overrides,
    }),
  );
  return root;
}

function entry(strategy: Entry['entry']['sessionHolding']['strategy']): Entry {
  return {
    entry: {
      id: 'oa',
      name: 'OA',
      via: 'direct',
      directUrl: 'http://oa',
      landingUrlPattern: '/home',
      excludeUrlPatterns: [],
      sessionType: 'cookie',
      sessionProbe: { url: '/api/session', okStatus: [200] },
      identityProbe: { url: '/api/userinfo', jsonPath: '$.sub', requiresAuth: true },
      loginUrlPatterns: ['/login'],
      loginTimeoutMs: 300_000,
      sessionHolding: { strategy, probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'unknown' },
      credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
    },
  };
}
