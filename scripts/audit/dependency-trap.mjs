import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const playwright = join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
const result = spawnSync(process.execPath, [
  playwright, 'test', 'e2e/t86-parameterization.spec.ts', '--workers=1',
], { cwd: process.cwd(), stdio: 'inherit' });

const passed = result.status === 0;
process.stdout.write([
  'T-85 dependency trap',
  `direct analyzer draft: ${passed ? 'PASS' : 'FAIL'}`,
  `cross parameter:       workday recording -> weekend replay`,
  `server value check:    ${passed ? 'weekend' : 'not verified'}`,
  '',
].join('\n'));
process.exitCode = passed ? 0 : 1;
