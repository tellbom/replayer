import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.cwd();
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const playwright = join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const phases = [
  ['recorder unit', [vitest, 'run', 'packages/recorder/src', '--passWithNoTests']],
  ['analyzer unit', [vitest, 'run', 'packages/analyzer/src', '--passWithNoTests']],
  ['replayer unit', [vitest, 'run', 'packages/replayer/src', '--passWithNoTests']],
  ['network capture', [playwright, 'test', 'e2e/network-record.spec.ts', '--workers=1']],
  ['network outcome', [playwright, 'test', 'e2e/channel-network.spec.ts', '--workers=1']],
  ['fallback policy', [playwright, 'test', 'e2e/fallback.spec.ts', '--workers=1']],
  ['direct disconnect', [playwright, 'test', 'e2e/t88-direct-drop-response.spec.ts', '--workers=1']],
  ['channel distribution', [join(root, 'scripts', 'audit', 'channel-distribution.mjs')]],
  ['dependency trap', [join(root, 'scripts', 'audit', 'dependency-trap.mjs')]],
];
const results = [];

for (const [name, args] of phases) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  results.push({ name, status: result.status === 0 ? 'PASS' : 'FAIL' });
}

process.stdout.write([
  '',
  'T-85 network health summary',
  ...results.map((result) => `${result.name.padEnd(21)} ${result.status}`),
  `overall${''.padEnd(15)} ${results.every((result) => result.status === 'PASS') ? 'PASS' : 'FAIL'}`,
  '',
].join('\n'));
process.exitCode = results.every((result) => result.status === 'PASS') ? 0 : 1;
