import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { commitHeal } from './skill-writer.js';
import type { Entry } from './schema.js';

const testEntry: Entry = {
  entry: {
    id: 'oa',
    name: 'OA',
    via: 'direct',
    directUrl: 'http://oa/login',
    landingUrlPattern: '/home',
    excludeUrlPatterns: [],
    sessionType: 'cookie',
    sessionProbe: { url: '/api/session', okStatus: [200] },
    identityProbe: { url: '/api/userinfo', jsonPath: '$.sub' },
    loginUrlPatterns: [],
    loginTimeoutMs: 300_000,
    sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'unknown' },
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};
const entryResolver = (): ((id: string) => Entry) => () => testEntry;

const yaml = `# TODO: 保留技能复核注释
skill:
  id: demo
  name: demo
  system: oa
  baseUrl: http://oa
  entry: oa
  version: 1
params: []
preflight: []
steps:
  # TODO: 保留步骤注释
  - id: s1
    desc: fill
    channel: ui
    riskLevel: read
    hasSideEffect: false
    ui:
      action: fill
      target: { strategy: el-form-item, label: 事由, kind: textarea }
      value: test
assertions: []
`;

describe('commitHeal', () => {
  it('写回已验证候选并保留原注释', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-heal-writer-'));
    const path = join(directory, 'skill.yaml');
    await writeFile(path, yaml, 'utf8');
    const updated = await commitHeal(path, {
      stepId: 's1',
      oldTarget: { strategy: 'el-form-item', label: '事由', kind: 'textarea' },
      newTarget: { strategy: 'el-form-item', label: '加班原因', kind: 'textarea' },
      resolveVerified: true,
      actionVerified: true,
      requiresConfirm: false,
      model: 'mock',
    }, '字段改名', entryResolver());

    const output = await readFile(path, 'utf8');
    expect(updated.skill.version).toBe(2);
    expect(updated._healHistory).toHaveLength(1);
    expect(output).toContain('# TODO: 保留技能复核注释');
    expect(output).toContain('# TODO: 保留步骤注释');
  });

  it('拒绝写回未完成动作验证的候选', async () => {
    await expect(commitHeal('unused.yaml', {
      stepId: 's1',
      oldTarget: { strategy: 'text', text: '旧' },
      newTarget: { strategy: 'text', text: '新' },
      resolveVerified: true,
      actionVerified: false,
      requiresConfirm: false,
      model: 'mock',
    }, '未验证', entryResolver())).rejects.toThrow('均验证通过');
  });
});
