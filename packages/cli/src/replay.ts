import { parseSkill } from '@dsh/core';
import type { Step } from '@dsh/core';
import { replay } from '@dsh/replayer';
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';

interface ReplayCliOptions {
  params: string;
  dryRun?: boolean;
  channel?: 'ui' | 'network';
  llm: boolean;
  profile: string;
  yes?: boolean;
}

export function configureReplayCommand(program: Command): void {
  program
    .command('replay <skill>')
    .description('按技能定义确定性回放业务流程')
    .requiredOption('--params <json-or-file>', '参数 JSON 字符串或 JSON 文件')
    .option('--dry-run', '只打印执行计划，不启动浏览器')
    .option('--channel <channel>', '强制通道：ui 或 network')
    .option('--no-llm', '禁用 LLM')
    .option('--profile <directory>', '持久化浏览器配置目录', './profiles/default')
    .option('--yes', '跳过高风险确认，仅用于自动化测试')
    .action(runReplay);
}

export async function runReplay(skillPath: string, options: ReplayCliOptions): Promise<void> {
  if (options.channel !== undefined && options.channel !== 'ui' && options.channel !== 'network') {
    throw new Error(`无效通道: ${options.channel}`);
  }
  const skill = parseSkill(await readFile(skillPath, 'utf8'));
  const params = await parseReplayParams(options.params);
  const confirm = options.yes ? async () => true : confirmRisk;
  const result = await replay(skill, {
    params,
    profileDir: options.profile,
    dryRun: options.dryRun,
    forceChannel: options.channel,
    noLLM: !options.llm,
    onConfirm: confirm,
  });
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
