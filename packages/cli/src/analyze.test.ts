import { parseSkill, type ILLMProvider, type RecordSession } from '@dsh/core';
import { Command } from 'commander';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { configureAnalyzeCommand, runAnalyze } from './analyze.js';
import type { Entry } from '@dsh/core';

const testEntry: Entry = {
  entry: {
    id: 'oa', name: 'OA', via: 'direct', directUrl: 'http://oa/login',
    landingUrlPattern: '/home', excludeUrlPatterns: [], sessionType: 'cookie',
    sessionProbe: { url: '/api/session', okStatus: [200] },
    identityProbe: { url: '/api/userinfo', jsonPath: '$.sub' },
    loginUrlPatterns: [], loginTimeoutMs: 300_000,
    sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'unknown' },
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};
const resolver = (): ((id: string) => Entry) => () => testEntry;

describe('dsh analyze', () => {
  it('exposes out and compare options', () => {
    const program = new Command().name('dsh');
    configureAnalyzeCommand(program);
    const help = program.commands[0]?.helpInformation() ?? '';
    expect(help).toContain('--out');
    expect(help).toContain('--compare');
    expect(help).toContain('--llm');
  });

  it('writes a schema-valid LLM annotated draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-analyze-llm-'));
    const output = join(root, 'draft.yaml');
    await writeFile(join(root, 'record.json'), JSON.stringify(session()), 'utf8');
    const llm: ILLMProvider = {
      name: 'mock',
      supportsVision: false,
      async chat() {
        return JSON.stringify({
          skill: { id: 'annotated', name: '标注技能', description: 'LLM 标注' },
          params: [],
          steps: [],
          assertions: [],
          warnings: ['复核风险'],
        });
      },
    };
    await runAnalyze(root, { out: output, llm: true }, llm);
    const yaml = await readFile(output, 'utf8');
    expect(parseSkill(yaml, resolver()).skill.id).toBe('annotated');
    expect(yaml).toContain('# TODO: LLM 建议');
  });

  it('reads a recording directory and writes a parseable draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-analyze-'));
    const output = join(root, 'skills', 'draft.yaml');
    const comparison = join(root, 'compare.json');
    await writeFile(join(root, 'record.json'), JSON.stringify(session()), 'utf8');
    await writeFile(comparison, JSON.stringify(session()), 'utf8');
    await runAnalyze(root, { out: output, compare: comparison });
    const skill = parseSkill(await readFile(output, 'utf8'), resolver());
    expect(skill.skill.id).toBe('recorded_skill');
    expect(skill.steps).toEqual([]);
  });
});

function session(): RecordSession {
  return {
    meta: {
      startedAt: '2026-08-18T00:00:00.000Z',
      endedAt: '2026-08-18T00:01:00.000Z',
      baseUrl: 'http://oa',
      userAgent: 'Chrome',
      entryId: 'oa',
    },
    actions: [],
    network: [],
    pages: [],
  };
}
