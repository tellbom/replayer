#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';

const root = process.cwd();
const violations = [];
for (const path of walk(resolve(root, 'packages'))) {
  if (!path.endsWith('.ts') || /\.(?:test|spec)\.ts$/.test(path)) continue;
  const rel = relative(root, path).replaceAll('\\', '/');
  const content = readFileSync(path, 'utf8');
  const packageName = rel.split('/')[1];
  for (const match of content.matchAll(/(?:import|export)\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g)) {
    const source = match[1];
    if (packageName === 'analyzer' && source === '@dsh/recorder') violations.push(`${rel}: analyzer -> recorder`);
    if (['core', 'analyzer', 'replayer', 'browser'].includes(packageName) && source.includes('adapters/')) {
      violations.push(`${rel}: ${packageName} -> adapters`);
    }
    if (packageName === 'locator' && !source.startsWith('.') && !source.startsWith('node:')) {
      violations.push(`${rel}: browser bundle imports npm package ${source}`);
    }
  }
}
if (violations.length > 0) {
  violations.forEach((item) => console.error(`✗ ${item}`));
  process.exit(1);
}
console.log('✓ package dependency and browser-bundle boundaries');

function walk(directory, output = []) {
  if (!existsSync(directory)) return output;
  for (const name of readdirSync(directory)) {
    if (name === 'dist' || name === 'node_modules') continue;
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) walk(path, output); else output.push(path);
  }
  return output;
}
