import { parseSkill, type RecordSession } from '@dsh/core';
import { Command } from 'commander';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { configureAnalyzeCommand, runAnalyze } from './analyze.js';

describe('dsh analyze', () => {
  it('exposes out and compare options', () => {
    const program = new Command().name('dsh');
    configureAnalyzeCommand(program);
    const help = program.commands[0]?.helpInformation() ?? '';
    expect(help).toContain('--out');
    expect(help).toContain('--compare');
  });

  it('reads a recording directory and writes a parseable draft', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-analyze-'));
    const output = join(root, 'skills', 'draft.yaml');
    const comparison = join(root, 'compare.json');
    await writeFile(join(root, 'record.json'), JSON.stringify(session()), 'utf8');
    await writeFile(comparison, JSON.stringify(session()), 'utf8');
    await runAnalyze(root, { out: output, compare: comparison });
    const skill = parseSkill(await readFile(output, 'utf8'));
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
    },
    actions: [],
    network: [],
    pages: [],
  };
}
