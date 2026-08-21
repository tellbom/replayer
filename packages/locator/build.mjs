import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

import { assertBrowserBundle } from './dist/_guard.js';

const VENDOR_TSCONFIG = '../../vendor/playwright-injected/1.62.1/tsconfig.json';

const entries = [
  ['el-locator', 'src/el-locator.ts'],
  ['recorder-probe', 'src/recorder-probe.ts'],
  ['selector-generator', 'src/selector-generator.ts'],
  ['snapshot', 'src/snapshot.ts'],
  ['mutation-tracker', 'src/mutation-tracker.ts'],
  ['ancestor-scope', 'src/ancestor-scope.ts'],
  ['visible-hint', 'src/visible-hint.ts', VENDOR_TSCONFIG],
  // 【T-63b】Playwright selectorGenerator（vendor 1.62.1）浏览器侧入口
  ['pw-selector-generator', 'src/pw-selector-generator.ts', VENDOR_TSCONFIG],
  // 【T-64】LLM 消歧局部上下文收集（浏览器侧）
  ['disambiguation-context', 'src/disambiguation-context.ts'],
];

for (const entry of entries) {
  const [name, entryPoint, tsconfig] = entry;
  const outfile = `dist/${name}.iife.js`;
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    ...(tsconfig ? { tsconfig } : {}),
  });
  assertBrowserBundle(await readFile(outfile, 'utf8'), outfile);
}
