import { spawnSync } from 'node:child_process';
import process from 'node:process';

const criticalTests = [
  {
    file: 'e2e/acceptance/a3-rebuild.spec.ts',
    title: 'A3 rebuild 后 CSS hash 变化但语义技能仍可回放',
  },
];

const playwrightArgs = [
  'playwright',
  'test',
  ...criticalTests.map(({ file }) => file),
  ...process.argv.slice(2),
  '--reporter=json',
];
const result = spawnSync(command('npx'), playwrightArgs, {
  cwd: process.cwd(),
  env: process.env,
  encoding: 'utf8',
  shell: process.platform === 'win32',
});

if (result.error) throw result.error;
if (!result.stdout.trim()) {
  process.stderr.write(result.stderr);
  throw new Error('Playwright 未产生 JSON 结果，无法检查核心验收状态');
}

const report = JSON.parse(result.stdout);
const tests = collectTests(report.suites ?? []);
const skipped = [];
const missing = [];

for (const critical of criticalTests) {
  const matches = tests.filter(
    (test) => {
      const expectedFile = normalize(critical.file).replace(/^e2e\//, '');
      return normalize(test.file).endsWith(expectedFile) && test.title === critical.title;
    },
  );
  if (matches.length === 0) {
    missing.push(critical);
    continue;
  }
  if (matches.some((test) => test.status === 'skipped')) skipped.push(critical);
}

if (skipped.length > 0 || missing.length > 0) {
  process.stderr.write('\n=== 核心验收门禁失败 ===\n');
  for (const test of skipped) process.stderr.write(`SKIPPED: ${test.file} :: ${test.title}\n`);
  for (const test of missing) process.stderr.write(`MISSING: ${test.file} :: ${test.title}\n`);
  if (process.env.ALLOW_CRITICAL_SKIP !== '1') process.exit(2);
  process.stderr.write('ALLOW_CRITICAL_SKIP=1：已显式允许核心验收跳过。\n');
}

process.stdout.write(result.stderr);
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write('核心验收未跳过。\n');

function collectTests(suites, inheritedFile = '') {
  const found = [];
  for (const suite of suites) {
    const file = suite.file ?? inheritedFile;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const statuses = (test.results ?? []).map(({ status }) => status);
        found.push({
          file: spec.file ?? file,
          title: spec.title,
          status: statuses.includes('skipped') || test.status === 'skipped' ? 'skipped' : test.status,
        });
      }
    }
    found.push(...collectTests(suite.suites ?? [], file));
  }
  return found;
}

function normalize(value) {
  return String(value ?? '').replaceAll('\\', '/').toLowerCase();
}

function command(binary) {
  return process.platform === 'win32' ? `${binary}.cmd` : binary;
}
