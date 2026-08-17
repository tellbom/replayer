import { spawn, spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import process from 'node:process';

const frontend = 'apps/mock-oa/frontend';

if (!(await readSubmitClass())) run('npm', ['run', 'build', '--workspace', 'mock-oa-frontend']);

for (let round = 1; round <= 5; round += 1) {
  const before = await readSubmitClass();
  run('npm', ['run', 'build', '--workspace', 'mock-oa-frontend']);
  const after = await readSubmitClass();
  if (before === after) throw new Error(`第 ${round} 轮 submitBtn class 未变化: ${before}`);
  process.stdout.write(`A3 第 ${round} 轮 class: ${before} -> ${after}\n`);

  const preview = spawn(command('npm'), [
    'run', 'preview', '--workspace', 'mock-oa-frontend', '--', '--host', '127.0.0.1', '--port', '5173',
  ], {
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    shell: process.platform === 'win32',
  });
  try {
    await waitForPreview();
    run('npx', [
      'playwright', 'test', 'e2e/acceptance/a3-rebuild.spec.ts', '--workers=1',
    ], { A3_EXPECTED_CLASS: after, A3_ROUND: String(round) });
  } finally {
    stopProcessTree(preview.pid);
  }
}

process.stdout.write('A3 rebuild 循环 5/5 通过\n');

function run(binary, args, extraEnv = {}) {
  const result = spawnSync(command(binary), args, {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${binary} ${args.join(' ')} 退出码 ${result.status}`);
}

function command(binary) {
  return process.platform === 'win32' ? `${binary}.cmd` : binary;
}

async function readSubmitClass() {
  let files;
  try {
    files = await readdir(`${frontend}/dist/assets`);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith('.css') && !file.endsWith('.js')) continue;
    const content = await readFile(`${frontend}/dist/assets/${file}`, 'utf8');
    const match = /submitBtn_[a-z0-9]{6}_[A-Za-z0-9_-]{5}/.exec(content);
    if (match) return match[0];
  }
  return null;
}

async function waitForPreview() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:5173/login');
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error('preview 未在 30 秒内启动');
}

function stopProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    process.kill(-pid, 'SIGTERM');
  }
}
