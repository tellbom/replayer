#!/usr/bin/env node
// 一键启动：同时起 mock-portal(4000) 与 mock-legacy-sys(4100)
// 用法：node apps/mock-portal/start-all.mjs
// 环境开关（透传两个子进程）：
//   PORTAL_COOKIE_MODE = persistent | session （默认 persistent）
//   PORTAL_COOKIE_MAX_AGE / PORTAL_SESSION_TTL = 秒（默认 14400）
//   SUB_COOKIE_MODE = session | persistent （默认 session）
//   SUB_SESSION_TTL = 秒（默认 300）
//   PORTAL_AUTH_FAIL_MODE / SUB_AUTH_FAIL_MODE = redirect | json （默认 redirect，K-4）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const procs = [
  spawn(process.execPath, [join(here, 'server.js')], { stdio: 'inherit', env: process.env }),
  spawn(process.execPath, [join(here, '..', 'mock-legacy-sys', 'server.js')], { stdio: 'inherit', env: process.env }),
];
const shutdown = () => procs.forEach((p) => { try { p.kill(); } catch {} });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
console.log('[start-all] mock-portal :4000 + mock-legacy-sys :4100 （Ctrl+C 退出）');
