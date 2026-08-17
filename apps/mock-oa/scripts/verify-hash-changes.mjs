import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../..', import.meta.url));
const assetsDir = fileURLToPath(new URL('../frontend/dist/assets', import.meta.url));
const viteCli = fileURLToPath(new URL('../../../node_modules/vite/bin/vite.js', import.meta.url));

const firstClass = await buildAndReadSubmitClass();
const secondClass = await buildAndReadSubmitClass();

if (firstClass === secondClass) {
  console.error(`submitBtn class 未变化: ${firstClass}`);
  process.exit(1);
}

console.log(`submitBtn class 已变化: ${firstClass} -> ${secondClass}`);

function buildAndReadSubmitClass() {
  const result = spawnSync(process.execPath, [viteCli, 'build', 'apps/mock-oa/frontend'], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return readSubmitClass();
}

async function readSubmitClass() {
  const assetNames = await readdir(assetsDir);
  for (const name of assetNames) {
    const content = await readFile(`${assetsDir}/${name}`, 'utf8');
    const match = /submitBtn_[a-z0-9]{6}_[A-Za-z0-9_-]{5}/.exec(content);
    if (match) return match[0];
  }
  throw new Error('构建产物中未找到 submitBtn CSS Module class');
}
