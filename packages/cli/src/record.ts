import { parseEntry } from '@dsh/core';
import type { Entry } from '@dsh/core';
import { record } from '@dsh/recorder';
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface RecordCliOptions {
  entry: string;
  out: string;
  profile: string;
  channel: 'chrome' | 'msedge';
  entries: string;
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
    .action(runRecord);
}

export async function runRecord(options: RecordCliOptions): Promise<void> {
  const entryPath = resolve(options.entries, `${options.entry}.yaml`);
  const entry: Entry = parseEntry(await readFile(entryPath, 'utf8'));
  await record({
    entry,
    outDir: options.out,
    profileDir: options.profile,
    channel: options.channel,
  });
  process.stdout.write(`录制已写入 ${options.out}/record.json\n`);
}
