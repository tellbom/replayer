/** 与 recorder RecordOptions.onDisambiguation 的输入同构（避免跨包深类型引用） */
interface DisambiguationCallbackInput {
  page: import('playwright').Page;
  targetElement: unknown;
  pwResult: { selector: string; matchCount: number; confidence: 'HIGH' | 'LOW' };
  context: {
    target: { tag: string; role: string | null; text: string; type: string | null; name: string | null; placeholder: string | null };
    ancestors: Array<{ tag: string; role: string | null; heading: string | null; sameNameCount: number }>;
    siblings: Array<{ role: string | null; text: string; type: string | null }>;
    sameNameCandidates: Array<{ index: number; nearestHeading: string | null }>;
  };
}

import { parseEntry } from '@dsh/core';
import type { Entry } from '@dsh/core';
import { disambiguateWithLLM, DeepSeekProvider } from '@dsh/llm';
import { record } from '@dsh/recorder';
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';

import { resolveSessionEndpoint } from './session.js';

interface RecordCliOptions {
  entry: string;
  out: string;
  profile: string;
  channel: 'chrome' | 'msedge';
  entries: string;
  stateDir: string;
  /** 【T-67b】启用录制期 LLM 消歧（仅 LOW 置信产物触发） */
  disambiguate: boolean;
  forceTakeover?: boolean;
}

export function configureRecordCommand(program: Command): void {
  program
    .command('record')
    .description('录制浏览器操作与网络请求（起点为 entry 建立的会话，不含登录）')
    .requiredOption('--entry <id>', 'entry 配置 id（entries/<id>.yaml）')
    .requiredOption('--out <directory>', 'record.json 输出目录')
    .option('--entries <directory>', 'entry 配置目录', './entries')
    .option('--profile <directory>', '持久化浏览器配置目录', './profiles/default')
    .option('--channel <channel>', '浏览器通道：chrome 或 msedge', 'chrome')
    .option('--state-dir <directory>', '会话状态目录', './.dsh')
    .option('--force-takeover', '显式关闭已知常驻浏览器后自行启动（会丢失会话）')
    .option('--disambiguate', 'LOW 置信定位产物触发 LLM 局部上下文消歧（需 DSH_LLM_* 配置）')
    .action(runRecord);
}

export async function runRecord(options: RecordCliOptions): Promise<void> {
  const entryPath = resolve(options.entries, `${options.entry}.yaml`);
  const entry: Entry = parseEntry(await readFile(entryPath, 'utf8'));
  const resumeSession = await loadConfirmedPartial(resolve(options.out, 'record.partial.json'));
  const cdpEndpoint = await resolveSessionEndpoint(entry, options.stateDir, options.forceTakeover);
  // 【T-67b】消歧回调：LLM 提案 → Playwright 再验证（count==1 且命中原元素）→
  // 通过返回 scoped selector（playwright 引擎语法），否则 null 保持 LOW 产物
  const onDisambiguation = options.disambiguate
    ? async (input: DisambiguationCallbackInput) => {
        const provider = new DeepSeekProvider();
        const outcome = await disambiguateWithLLM(provider, {
          page: input.page,
          targetElement: input.targetElement,
          pwResult: input.pwResult,
          context: input.context,
        });
        if (!outcome.accepted || !outcome.proposal?.scopeHint?.heading) return null;
        // scoped selector：scope(tag 含 heading 文本) 内 getByRole——以 Playwright
        // 引擎语法表达（section:has-text(...) >> internal:role=...）
        const tag = outcome.proposal.scopeHint.tag;
        const heading = outcome.proposal.scopeHint.heading;
        const role = input.context.target.role ?? 'button';
        const name = input.context.target.text.replace(/["\\]/g, '\\$&');
        return `${tag}:has-text("${heading}") >> internal:role=${role}[name="${name}"i]`;
      }
    : undefined;
  await record({
    entry,
    outDir: options.out,
    profileDir: options.profile,
    channel: options.channel,
    cdpEndpoint,
    onDisambiguation,
    resumeSession,
  });
  process.stdout.write(`录制已写入 ${options.out}/record.json\n`);
}

async function loadConfirmedPartial(path: string): Promise<import('@dsh/core').RecordSession | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  process.stdout.write(`检测到未完成录制：${path}\n`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('存在 record.partial.json；非交互环境无法确认恢复，请人工处理后重试');
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await prompt.question('是否从该 partial 继续录制？[y/N] ');
    if (!/^y(?:es)?$/i.test(answer.trim())) return undefined;
  } finally {
    prompt.close();
  }
  const parsed = JSON.parse(text) as Partial<import('@dsh/core').RecordSession>;
  if (!parsed.meta || !Array.isArray(parsed.canonicalActions)
      || !Array.isArray(parsed.network) || !Array.isArray(parsed.pages)) {
    throw new Error('record.partial.json 结构无效，无法恢复');
  }
  return parsed as import('@dsh/core').RecordSession;
}
