import { readLiveSession, sessionStatePath } from '@dsh/browser';
import type { Entry } from '@dsh/core';
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

interface SessionOptions {
  entry?: string;
  entries: string;
  profile: string;
  stateDir: string;
  channel: 'chrome' | 'msedge';
}

const START_TIMEOUT_MS = 15_000;
const START_POLL_MS = 100;

export function configureSessionCommand(program: Command): void {
  const session = program.command('session').description('管理浏览器常驻会话');
  session
    .command('start')
    .requiredOption('--entry <id>', 'entry 配置 id')
    .option('--entries <directory>', 'entry 配置目录', './entries')
    .option('--profile <directory>', '持久化浏览器配置目录', './profiles/default')
    .option('--state-dir <directory>', '会话状态目录', './.dsh')
    .option('--channel <channel>', '浏览器通道', 'chrome')
    .action(startSession);
  session
    .command('status')
    .option('--entry <id>', '只查看指定 entry')
    .option('--state-dir <directory>', '会话状态目录', './.dsh')
    .action(statusSession);
  session
    .command('stop')
    .requiredOption('--entry <id>', 'entry 配置 id')
    .option('--state-dir <directory>', '会话状态目录', './.dsh')
    .action(stopSession);
}

export async function resolveSessionEndpoint(
  entry: Entry,
  stateDir: string,
): Promise<string | undefined> {
  const strategy = entry.entry.sessionHolding.strategy;
  if (strategy === 'probe-only') return undefined;
  if (strategy === 'storage-state') {
    throw new Error(`entry ${entry.entry.id} 使用 storage-state；T-78 尚未启用`);
  }
  const state = await readLiveSession(resolve(stateDir), entry.entry.id);
  if (!state) {
    throw new Error(
      `entry ${entry.entry.id} 无常驻会话，请先执行 dsh session start --entry ${entry.entry.id}`,
    );
  }
  if (state.status !== 'active') {
    throw new Error(`entry ${entry.entry.id} 会话状态为 ${state.status}，请先完成登录或重新建立会话`);
  }
  return state.endpoint;
}

export async function startSession(options: SessionOptions): Promise<void> {
  const entryId = options.entry!;
  const stateDir = resolve(options.stateDir);
  const statePath = sessionStatePath(stateDir, entryId);
  const existing = await readLiveSession(stateDir, entryId);
  if (existing) throw new Error(`entry ${entryId} 已有会话进程 pid=${existing.pid}`);
  await mkdir(stateDir, { recursive: true });
  const daemonPath = fileURLToPath(new URL('./session-daemon.js', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      daemonPath,
      '--entry-path',
      resolve(options.entries, `${entryId}.yaml`),
      '--profile',
      resolve(options.profile),
      '--state',
      statePath,
      '--channel',
      options.channel,
    ],
    { detached: true, stdio: 'ignore', windowsHide: true },
  );
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const state = await readLiveSession(stateDir, entryId);
    if (state) {
      process.stdout.write(
        `会话进程已启动 entry=${state.entryId} pid=${state.pid} status=${state.status}\n`,
      );
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, START_POLL_MS));
  }
  throw new Error(`会话进程启动超时: ${entryId}`);
}

export async function statusSession(options: Pick<SessionOptions, 'entry' | 'stateDir'>): Promise<void> {
  const stateDir = resolve(options.stateDir);
  const ids = options.entry ? [options.entry] : await sessionIds(stateDir);
  if (ids.length === 0) {
    process.stdout.write('无会话\n');
    return;
  }
  for (const id of ids) {
    const state = await readLiveSession(stateDir, id);
    if (!state) {
      process.stdout.write(`Entry: ${id}  无会话\n`);
      continue;
    }
    process.stdout.write(
      `Entry: ${id}  ${state.status}  pid=${state.pid}  探测=${state.lastProbeAt ?? '等待登录'}\n`,
    );
  }
}

export async function stopSession(options: Pick<SessionOptions, 'entry' | 'stateDir'>): Promise<void> {
  const stateDir = resolve(options.stateDir);
  const entryId = options.entry!;
  const state = await readLiveSession(stateDir, entryId);
  if (!state) {
    process.stdout.write(`Entry: ${entryId}  无会话\n`);
    return;
  }
  process.kill(state.pid, 'SIGTERM');
  await rm(sessionStatePath(stateDir, entryId), { force: true });
  process.stdout.write(`会话已停止 entry=${entryId}\n`);
}

async function sessionIds(stateDir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names
    .filter((name) => /^session-.+\.json$/.test(name))
    .map((name) => name.slice('session-'.length, -'.json'.length));
}
