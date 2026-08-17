import type { AuthConfig } from '@dsh/browser';
import { record } from '@dsh/recorder';
import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';

interface RecordCliOptions {
  url: string;
  out: string;
  profile: string;
  channel: 'chrome' | 'msedge';
  auth?: string;
}

export function configureRecordCommand(program: Command): void {
  program
    .command('record')
    .description('录制浏览器操作与网络请求')
    .requiredOption('--url <url>', '录制起始地址')
    .requiredOption('--out <directory>', 'record.json 输出目录')
    .option('--profile <directory>', '持久化浏览器配置目录', './profiles/default')
    .option('--channel <channel>', '浏览器通道：chrome 或 msedge', 'chrome')
    .option('--auth <file>', '认证配置 JSON 文件')
    .action(runRecord);
}

export async function runRecord(options: RecordCliOptions): Promise<void> {
  const auth: AuthConfig | undefined = options.auth
    ? JSON.parse(await readFile(options.auth, 'utf8'))
    : undefined;
  await record({
    url: options.url,
    outDir: options.out,
    profileDir: options.profile,
    channel: options.channel,
    auth,
  });
  process.stdout.write(`录制已写入 ${options.out}/record.json\n`);
}
