import { readLiveSession, sessionStatePath } from '@dsh/browser';
import { parseEntry, type Entry } from '@dsh/core';
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

interface SessionOptions {
  entry?: string;
  entries: string;
  profile: string;
  stateDir: string;
  channel: 'chrome' | 'msedge';
  forceTakeover?: boolean;
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
    .option('--force-takeover', '显式关闭已知常驻实例后重新启动（会丢失会话）')
    .action(startSession);
  session
    .command('status')
    .option('--entry <id>', '只查看指定 entry')
    .option('--entries <directory>', 'entry 配置目录', './entries')
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
  forceTakeover = false,
): Promise<string | undefined> {
  const strategy = entry.entry.sessionHolding.strategy;
  if (strategy === 'probe-only') return undefined;
  if (strategy === 'storage-state') {
    throw new Error(`entry ${entry.entry.id} 使用 storage-state；T-78 尚未启用`);
  }
  const state = await readLiveSession(resolve(stateDir), entry.entry.id);
  if (!state) return undefined;
  if (forceTakeover) {
    process.stdout.write(
      `警告：--force-takeover 将关闭 entry ${entry.entry.id} 的现有浏览器，会话可能丢失。\n`,
    );
    await terminateKnownSession(state.pid, resolve(stateDir), entry.entry.id);
    return undefined;
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
  if (existing && !options.forceTakeover) {
    throw new Error(`entry ${entryId} 已有会话进程 pid=${existing.pid}`);
  }
  if (existing) {
    process.stdout.write(`警告：--force-takeover 将关闭现有浏览器 pid=${existing.pid}，会话可能丢失。\n`);
    await terminateKnownSession(existing.pid, stateDir, entryId);
  }
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

export async function statusSession(options: Pick<SessionOptions, 'entry' | 'entries' | 'stateDir'>): Promise<void> {
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
    const entry = await readEntry(options.entries, id);
    process.stdout.write(renderSessionStatus(id, state, entry));
  }
}

async function terminateKnownSession(pid: number, stateDir: string, entryId: string): Promise<void> {
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      await rm(sessionStatePath(stateDir, entryId), { force: true });
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, START_POLL_MS));
  }
  throw new Error(`无法接管仍在运行的会话进程 pid=${pid}；未启动新浏览器`);
}

async function readEntry(directory: string, id: string): Promise<Entry | null> {
  try {
    return parseEntry(await readFile(resolve(directory, `${id}.yaml`), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function renderSessionStatus(
  id: string,
  state: NonNullable<Awaited<ReturnType<typeof readLiveSession>>>,
  entry: Entry | null,
): string {
  const lines = [
    `Entry: ${id}`,
    `  会话探测      ${state.status === 'active' ? '✓ 有效' : state.status === 'invalid' ? '✗ 已失效' : '… 等待登录'}`,
    `  身份          ${state.identityDigest ? `sha256:${state.identityDigest.slice(0, 8)}` : '等待确认'}`,
    `  浏览器进程    ✓ 存活 (pid ${state.pid})`,
    `  CDP endpoint  ${state.endpoint}`,
    `  最近探测      ${state.lastProbeAt ?? '等待登录'}`,
  ];
  const expected = entry?.entry.sessionHolding.expectedPortalTtlMs;
  const established = state.sessionEstablishedAt ? Date.parse(state.sessionEstablishedAt) : Number.NaN;
  if (expected !== undefined && Number.isFinite(established)) {
    const remaining = established + expected - Date.now();
    lines.push(`  门户 TTL 估算 ${remaining > 0 ? `剩余约 ${formatDuration(remaining)}` : '预计时长已耗尽（以真实探测为准）'}`);
    const warnBefore = entry?.entry.sessionHolding.warnBeforeExpiryMs;
    if (warnBefore !== undefined && remaining > 0 && remaining <= warnBefore) {
      lines.push(`  ⚠ 门户会话预计将在约 ${formatDuration(remaining)}后到达配置 TTL，请在长流程前重新认证。`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours > 0 ? `${hours}小时${rest > 0 ? `${rest}分钟` : ''}` : `${minutes}分钟`;
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
