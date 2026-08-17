import { generateDraft } from '@dsh/analyzer';
import type { RecordSession } from '@dsh/core';
import type { Command } from 'commander';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

interface AnalyzeOptions {
  out: string;
  compare?: string;
}

export function configureAnalyzeCommand(program: Command): void {
  program
    .command('analyze <recording>')
    .description('分析 record.json 并生成技能草稿')
    .requiredOption('--out <file>', 'draft.yaml 输出路径')
    .option('--compare <recording>', '第二份录制，用于增强参数识别')
    .action(runAnalyze);
}

export async function runAnalyze(recording: string, options: AnalyzeOptions): Promise<void> {
  const session = await readRecording(recording);
  const comparison = options.compare ? await readRecording(options.compare) : undefined;
  const result = generateDraft(session, comparison);
  await mkdir(dirname(options.out), { recursive: true });
  await writeFile(options.out, result.yaml, 'utf8');
  process.stdout.write(`技能草稿已写入 ${options.out}\n`);
}

async function readRecording(path: string): Promise<RecordSession> {
  const file = (await stat(path)).isDirectory() ? join(path, 'record.json') : path;
  return JSON.parse(await readFile(file, 'utf8'));
}
