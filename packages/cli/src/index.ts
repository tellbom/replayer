#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configureAnalyzeCommand } from './analyze.js';
import { runDoctor } from './doctor.js';
import { configureDiffCommand } from './diff.js';
import { configureRecordCommand } from './record.js';
import { configureReplayCommand } from './replay.js';
import { configureRunCommand } from './run.js';
import { configureSessionCommand } from './session.js';

export function createProgram(): Command {
  const program = new Command();
  program.name('dsh').description('DSH Recorder CLI');
  configureAnalyzeCommand(program);
  program
    .command('doctor')
    .description('检查浏览器载体与内网迁移前置条件')
    .option('--probe-frontend <url>', '探测目标页面的 Vue/Element 版本')
    .option('--probe-entry', '探测目标系统会话类型并生成 entry 配置草稿')
    .option('--portal <url>', 'entry 探测：门户地址')
    .option('--direct <url>', 'entry 探测：直达地址')
    .option('--target <id>', 'entry 探测：目标系统 id', 'oa')
    .option('--entries <directory>', 'entry 配置输出目录', './entries')
    .option('--profile <directory>', 'probe-entry 使用的持久 profile（需已登录）')
    .option('--session-strategy <strategy>', 'entry 会话持有策略', 'daemon')
    .action(async (options: import('./doctor.js').DoctorOptions) => runDoctor(options));
  configureRecordCommand(program);
  configureDiffCommand(program);
  configureReplayCommand(program);
  configureRunCommand(program);
  configureSessionCommand(program);
  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await createProgram().parseAsync();
}
