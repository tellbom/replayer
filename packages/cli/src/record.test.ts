import { Command } from 'commander';
import { describe, expect, it } from 'vitest';

import { configureRecordCommand } from './record.js';

describe('dsh record', () => {
  it('exposes every required recording option', () => {
    const program = new Command().name('dsh');
    configureRecordCommand(program);
    const command = program.commands.find((candidate) => candidate.name() === 'record');
    const help = command?.helpInformation() ?? '';

    for (const option of ['--url', '--out', '--profile', '--channel', '--auth']) {
      expect(help).toContain(option);
    }
  });
});
