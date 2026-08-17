#!/usr/bin/env node

import { Command } from 'commander';

import { configureAnalyzeCommand } from './analyze.js';
import { runDoctor } from './doctor.js';
import { configureDiffCommand } from './diff.js';
import { configureRecordCommand } from './record.js';

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

await program.parseAsync();
