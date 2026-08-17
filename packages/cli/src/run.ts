import {
  NoMatchingSkillError,
  TokenBudgetExceededError,
  parseSkill,
} from '@dsh/core';
import type { ILLMProvider, Skill, Step } from '@dsh/core';
import { DeepSeekProvider, executeHeal, proposeHeal, route } from '@dsh/llm';
import { replay } from '@dsh/replayer';
import type { ReplayOptions } from '@dsh/replayer';
import type { Command } from 'commander';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

interface RunCliOptions {
  skills: string;
  skill?: string;
  params?: string;
  profile: string;
  llm: boolean;
  yes?: boolean;
  dryRun?: boolean;
}

interface LoadedSkill {
  path: string;
  skill: Skill;
}

interface RunDependencies {
  provider?: ILLMProvider;
  replayImpl?: typeof replay;
}

export function configureRunCommand(program: Command): void {
  program
    .command('run <instruction>')
    .description('用自然语言选择并执行已录制技能')
    .option('--skills <directory>', '技能目录', './skills')
    .option('--skill <file>', '--no-llm 时明确指定技能文件')
    .option('--params <json>', '--no-llm 时提供确定性参数 JSON', '{}')
    .option('--profile <directory>', '持久化浏览器配置目录', './profiles/default')
    .option('--no-llm', '跳过路由和自愈，仅确定性回放')
    .option('--yes', '跳过高风险确认，仅用于自动化测试')
    .option('--dry-run', '只打印执行计划')
    .action(runNaturalLanguage);
}

export async function runNaturalLanguage(
  instruction: string,
  options: RunCliOptions,
  dependencies: RunDependencies = {},
): Promise<void> {
  const loaded = await loadSkills(options.skills);
  const confirm = options.yes ? async () => true : confirmRisk;
  const replayImpl = dependencies.replayImpl ?? replay;

  if (!options.llm) {
    const selected = options.skill
      ? loaded.find((item) => resolve(item.path) === resolve(options.skill!))
      : loaded.find((item) => item.skill.skill.id === instruction || item.skill.skill.name === instruction);
    if (!selected) throw noMatchingSkill();
    const params = JSON.parse(options.params ?? '{}') as Record<string, unknown>;
    await outputReplay(await replayImpl(selected.skill, replayOptions(options, params, confirm)));
    return;
  }

  const provider = budgetProvider(dependencies.provider ?? new DeepSeekProvider());
  const routed = await route(provider, instruction, loaded.map((item) => item.skill));
  if (!routed.skillId) throw noMatchingSkill();
  if (routed.missing.length > 0) {
    throw new Error(`MISSING_PARAMS: ${routed.missing.join(', ')}`);
  }
  const selected = loaded.find((item) => item.skill.skill.id === routed.skillId);
  if (!selected) throw noMatchingSkill();
  const optionsForReplay = replayOptions(options, routed.params, confirm);
  optionsForReplay.onLocatorFailure = async ({ page, skill, step, error, context }) => {
    const snapshot = await page.evaluate(() => window.__DSH_SNAPSHOT__());
    const candidate = await proposeHeal({ llm: provider, page, step, error, snapshot });
    if (!candidate) return null;
    const verified = await executeHeal({
      page,
      skill,
      skillPath: selected.path,
      candidate,
      context,
      reason: error.message,
      onConfirm: confirm,
    });
    return verified ? {
      stepId: step.id,
      ok: true,
      outcome: 'confirmed_success',
      channelUsed: 'ui',
      durationMs: 0,
      healed: true,
    } : null;
  };
  await outputReplay(await replayImpl(selected.skill, optionsForReplay));
}

async function loadSkills(directory: string): Promise<LoadedSkill[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
    .map((entry) => join(directory, entry.name));
  return Promise.all(files.map(async (path) => ({
    path,
    skill: parseSkill(await readFile(path, 'utf8')),
  })));
}

function replayOptions(
  options: RunCliOptions,
  params: Record<string, unknown>,
  confirm: NonNullable<ReplayOptions['onConfirm']>,
): ReplayOptions {
  return {
    params,
    profileDir: options.profile,
    dryRun: options.dryRun,
    noLLM: !options.llm,
    onConfirm: confirm,
  };
}

function budgetProvider(provider: ILLMProvider): ILLMProvider {
  const budget = Number.parseInt(process.env.DSH_TOKEN_BUDGET ?? '50000', 10);
  let used = 0;
  return {
    name: provider.name,
    supportsVision: provider.supportsVision,
    async chat(messages, opts) {
      used += estimate(messages.map((message) => message.content).join(''));
      if (used > budget) throw new TokenBudgetExceededError(`LLM token 预算已超过 ${budget}`);
      const response = await provider.chat(messages, opts);
      used += estimate(response);
      if (used > budget) throw new TokenBudgetExceededError(`LLM token 预算已超过 ${budget}`);
      return response;
    },
  };
}

function estimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function noMatchingSkill(): NoMatchingSkillError {
  return new NoMatchingSkillError('NO_MATCHING_SKILL: 请先录制或创建匹配的技能');
}

async function outputReplay(result: Awaited<ReturnType<typeof replay>>): Promise<void> {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
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
