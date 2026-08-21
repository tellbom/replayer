import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parse } from 'yaml';

const skillRoot = join(process.cwd(), 'skills');
const files = (await readdir(skillRoot)).filter((file) => /\.ya?ml$/i.test(file)).sort();
const channels = { network: 0, ui: 0, merged: 0, auto: 0 };
let steps = 0;

for (const file of files) {
  const skill = parse(await readFile(join(skillRoot, file), 'utf8'));
  for (const step of skill.steps ?? []) {
    if (!(step.channel in channels)) throw new Error(`${file}: unknown channel ${step.channel}`);
    channels[step.channel] += 1;
    steps += 1;
  }
}

process.stdout.write([
  'T-85 channel distribution',
  `skills:  ${files.length}`,
  `steps:   ${steps}`,
  `network: ${channels.network}`,
  `ui:      ${channels.ui}`,
  `merged:  ${channels.merged}`,
  `auto:    ${channels.auto}`,
  `json:    ${JSON.stringify({ skills: files.length, steps, channels })}`,
  '',
].join('\n'));
