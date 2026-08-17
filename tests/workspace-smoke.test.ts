import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageNames = [
  'core',
  'locator',
  'browser',
  'recorder',
  'analyzer',
  'replayer',
  'llm',
  'cli',
] as const;

describe('T-01 工作区骨架', () => {
  it.each(packageNames)('@dsh/%s 包可从源码入口导入', async (name) => {
    const entryUrl = new URL(`../packages/${name}/src/index.ts`, import.meta.url);
    await expect(import(entryUrl.href)).resolves.toBeDefined();
  });

  it.each(packageNames)('@dsh/%s 包清单使用统一 ESM 约定', async (name) => {
    const manifestUrl = new URL(`../packages/${name}/package.json`, import.meta.url);
    const manifest = JSON.parse(await readFile(fileURLToPath(manifestUrl), 'utf8')) as {
      name: string;
      type: string;
    };

    expect(manifest.name).toBe(`@dsh/${name}`);
    expect(manifest.type).toBe('module');
  });
});
