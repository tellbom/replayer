import { Command } from 'commander';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { configureReplayCommand, parseReplayParams } from './replay.js';

describe('dsh replay', () => {
  it('exposes every replay option', () => {
    const program = new Command().name('dsh');
    configureReplayCommand(program);
    const help = program.commands[0]?.helpInformation() ?? '';
    for (const option of ['--params', '--dry-run', '--channel', '--no-llm', '--profile', '--yes']) {
      expect(help).toContain(option);
    }
  });

  it('parses inline JSON parameters', async () => {
    await expect(parseReplayParams('{"type":"工作日加班"}')).resolves.toEqual({
      type: '工作日加班',
    });
  });

  it('parses parameters from a JSON file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-replay-'));
    const file = join(root, 'params.json');
    await writeFile(file, '{"reason":"版本上线"}', 'utf8');
    await expect(parseReplayParams(file)).resolves.toEqual({ reason: '版本上线' });
  });

  it('rejects non-object parameters', async () => {
    await expect(parseReplayParams('[1,2]')).rejects.toThrow('回放参数必须是 JSON 对象');
  });
});
