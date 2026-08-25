import type { Entry } from '@dsh/core';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveSessionEndpoint } from './session.js';

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
    await expect(resolveSessionEndpoint(entry('daemon'), root)).rejects.toThrow('无常驻会话');
    await expect(access(join(root, 'session-oa.json'))).rejects.toMatchObject({ code: 'ENOENT' });
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

async function stateDir(overrides: { status: 'active' | 'invalid'; pid: number }): Promise<string> {
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
