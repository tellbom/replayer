#!/usr/bin/env node

import { Command } from 'commander';

import { runDoctor } from './doctor.js';

const program = new Command();

program.name('dsh').description('DSH Recorder CLI');
program
  .command('doctor')
  .description('检查浏览器载体与内网迁移前置条件')
  .option('--probe-frontend <url>', '探测目标页面的 Vue/Element 版本')
  .action(async (options: { probeFrontend?: string }) => runDoctor(options));

await program.parseAsync();
