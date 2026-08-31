#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const rootArg = process.argv.indexOf('--root');
const root = resolve(rootArg >= 0 ? process.argv[rootArg + 1] : process.cwd());
const packages = resolve(root, 'packages');
const patterns = [
  /\bel-[a-z]+/i,
  /\bant-[a-z]+/i,
  /\barco-[a-z]+/i,
  /\bMui[A-Z]/,
  /element-(plus|ui)/i,
  /\bantd\b/i,
];
const violations = [];

for (const path of walk(packages)) {
  if (!path.endsWith('.ts') || /\.(?:test|spec)\.ts$/.test(path) || path.includes(`${sep()}vendor${sep()}`)) continue;
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!patterns.some((pattern) => pattern.test(line))) return;
    violations.push(`${path}:${index + 1}: ${line.trim()}`);
  });
}

if (violations.length > 0) {
  console.error('Framework-specific production code is forbidden:');
  violations.forEach((item) => console.error(`  ${item}`));
  process.exit(1);
}
console.log('✓ packages production code contains no framework-specific tokens');

function walk(directory, output = []) {
  if (!existsSync(directory)) return output;
  for (const name of readdirSync(directory)) {
    if (name === 'dist' || name === 'node_modules') continue;
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) walk(path, output); else output.push(path);
  }
  return output;
}

function sep() { return process.platform === 'win32' ? '\\' : '/'; }
