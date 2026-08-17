#!/usr/bin/env node

import { Command } from 'commander';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { configureAnalyzeCommand } from './analyze.js';
import { runDoctor } from './doctor.js';
import { configureDiffCommand } from './diff.js';
import { configureRecordCommand } from './record.js';
import { configureReplayCommand } from './replay.js';

export function createProgram(): Command {
  const program = new Command();
  program.name('dsh').description('DSH Recorder CLI');
  configureAnalyzeCommand(program);
  program
    .command('doctor')
    .description('检查浏览器载体与内网迁移前置条件')
    .option('--probe-frontend <url>', '探测目标页面的 Vue/Element 版本')
    .action(async (options: { probeFrontend?: string }) => runDoctor(options));
  configureRecordCommand(program);
  configureDiffCommand(program);
  configureReplayCommand(program);
  return program;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await createProgram().parseAsync();
}
