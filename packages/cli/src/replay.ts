import { parseEntry, parseSkill } from '@dsh/core';
import type { Entry, Step } from '@dsh/core';
import { replay } from '@dsh/replayer';
import type { RunResult } from '@dsh/core';
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

import { resolveSessionEndpoint } from './session.js';
import {
  finishVerification,
  prepareVerification,
  terminalVerificationPrompter,
} from './verification.js';
import type { VerificationPrompter } from './verification.js';

interface ReplayCliOptions {
  params: string;
  dryRun?: boolean;
  channel?: 'ui' | 'network';
  llm: boolean;
  profile: string;
  entries: string;
  stateDir: string;
  yes?: boolean;
}

interface ReplayDependencies {
  replayImpl?: typeof replay;
  sessionEndpoint?: typeof resolveSessionEndpoint;
  verificationPrompter?: VerificationPrompter;
}

export function configureReplayCommand(program: Command): void {
  program
    .command('replay <skill>')
    .description('按技能定义确定性回放业务流程')
    .requiredOption('--params <json-or-file>', '参数 JSON 字符串或 JSON 文件')
    .option('--dry-run', '只打印执行计划，不启动浏览器')
    .option('--channel <channel>', '强制通道：ui 或 network')
    .option('--no-llm', '禁用 LLM')
    .option('--entries <directory>', 'entry 认证载体配置目录', './entries')
    .option('--profile <directory>', '持久化浏览器配置目录', './profiles/default')
    .option('--state-dir <directory>', '会话状态目录', './.dsh')
    .option('--yes', '跳过高风险确认，仅用于自动化测试')
    .action(runReplay);
}

export async function runReplay(
  skillPath: string,
  options: ReplayCliOptions,
  dependencies: ReplayDependencies = {},
): Promise<void> {
  if (options.channel !== undefined && options.channel !== 'ui' && options.channel !== 'network') {
    throw new Error(`无效通道: ${options.channel}`);
  }
  const entryCache = new Map<string, Entry>();
  const loadEntrySync = (id: string): Entry => {
    const cached = entryCache.get(id);
    if (cached) return cached;
    throw new Error(`entry 配置不存在: entries/${id}.yaml`);
  };
  const skillText = await readFile(skillPath, 'utf8');
  const entryId = /^[ \t]*entry:[ \t]*(\S+)/m.exec(skillText)?.[1];
  if (!entryId) throw new Error('技能缺少 skill.entry 字段');
  const entry: Entry = parseEntry(
    await readFile(resolve(options.entries, `${entryId}.yaml`), 'utf8'),
  );
  entryCache.set(entryId, entry);
  const skill = parseSkill(skillText, loadEntrySync);
  const prompter = dependencies.verificationPrompter ?? terminalVerificationPrompter;
  const verification = await prepareVerification(skill, skillPath, prompter, options.dryRun);
  if (!verification.proceed) return;
  const params = await parseReplayParams(options.params);
  const cdpEndpoint = options.dryRun
    ? undefined
    : await (dependencies.sessionEndpoint ?? resolveSessionEndpoint)(entry, options.stateDir);
  const confirm = options.yes ? async () => true : confirmRisk;
  let result: RunResult | undefined;
  try {
    result = await (dependencies.replayImpl ?? replay)(skill, {
      params,
      profileDir: options.profile,
      entry,
      cdpEndpoint,
      dryRun: options.dryRun,
      forceChannel: options.channel,
      noLLM: !options.llm,
      supervisedVerification: verification.supervised,
      onConfirm: confirm,
    });
  } finally {
    await finishVerification(skill, skillPath, verification, result, prompter);
  }
  if (!options.dryRun) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

export async function parseReplayParams(input: string): Promise<Record<string, unknown>> {
  const trimmed = input.trim();
  const text = trimmed.startsWith('{') || trimmed.startsWith('[') ? input : await readFile(input, 'utf8');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('回放参数必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

async function confirmRisk(step: Step): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question(
      `步骤 ${step.id} 为 ${step.riskLevel} 操作：${step.desc}，确认执行？[y/N] `,
    );
    return answer.trim().toLowerCase() === 'y';
  } finally {
    prompt.close();
  }
}
