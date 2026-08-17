import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

import { assertBrowserBundle } from './dist/_guard.js';

const entries = [
  ['el-locator', 'src/el-locator.ts'],
  ['recorder-probe', 'src/recorder-probe.ts'],
  ['selector-generator', 'src/selector-generator.ts'],
  ['snapshot', 'src/snapshot.ts'],
];

for (const [name, entryPoint] of entries) {
  const outfile = `dist/${name}.iife.js`;
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
  });
  assertBrowserBundle(await readFile(outfile, 'utf8'), outfile);
}
