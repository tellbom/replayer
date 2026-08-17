import type { ILLMProvider, RunResult, Skill } from '@dsh/core';
import { Command } from 'commander';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';

import { configureRunCommand, runNaturalLanguage } from './run.js';

const skill: Skill = {
  skill: { id: 'demo', name: '演示技能', description: '执行演示', system: 'oa', baseUrl: 'http://oa', version: 1 },
  params: [], preflight: [], steps: [], assertions: [],
};
const success: RunResult = { ok: true, skillId: 'demo', steps: [], extracted: {} };

afterEach(() => {
  delete process.env.DSH_TOKEN_BUDGET;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe('dsh run', () => {
  it('exposes Core run options', () => {
    const program = new Command().name('dsh');
    configureRunCommand(program);
    const help = program.commands[0]?.helpInformation() ?? '';
    for (const option of ['--skills', '--skill', '--params', '--profile', '--no-llm', '--yes']) {
      expect(help).toContain(option);
    }
  });

  it('routes a natural-language instruction and replays the matched skill', async () => {
    const directory = await skillsDirectory();
    const replayImpl = vi.fn(async () => success);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runNaturalLanguage('执行演示', options(directory), {
      provider: mockLLM({ skillId: 'demo', params: {}, sources: {} }),
      replayImpl,
    });
    expect(replayImpl).toHaveBeenCalledWith(skill, expect.objectContaining({ params: {}, noLLM: false }));
  });

  it('returns controlled NO_MATCHING_SKILL instead of entering exploration', async () => {
    const directory = await skillsDirectory();
    await expect(runNaturalLanguage('未知任务', options(directory), {
      provider: mockLLM({ skillId: null, params: {}, sources: {} }),
      replayImpl: vi.fn(async () => success),
    })).rejects.toMatchObject({ code: 'NO_MATCHING_SKILL' });
  });

  it('--no-llm performs deterministic replay without constructing a provider', async () => {
    const directory = await skillsDirectory();
    const replayImpl = vi.fn(async () => success);
    vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await runNaturalLanguage('demo', { ...options(directory), llm: false }, { replayImpl });
    expect(replayImpl).toHaveBeenCalledWith(skill, expect.objectContaining({ noLLM: true }));
  });

  it('stops when the configured token budget is exceeded', async () => {
    const directory = await skillsDirectory();
    process.env.DSH_TOKEN_BUDGET = '1';
    await expect(runNaturalLanguage('执行演示', options(directory), {
      provider: mockLLM({ skillId: 'demo', params: {}, sources: {} }),
      replayImpl: vi.fn(async () => success),
    })).rejects.toMatchObject({ code: 'TOKEN_BUDGET_EXCEEDED' });
  });
});

function options(skills: string) {
  return { skills, profile: './profiles/test', llm: true, yes: true };
}

function mockLLM(response: object): ILLMProvider {
  return {
    name: 'mock', supportsVision: false,
    async chat() { return JSON.stringify(response); },
  };
}

async function skillsDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-run-'));
  await writeFile(join(directory, 'demo.yaml'), stringify(skill), 'utf8');
  return directory;
}
