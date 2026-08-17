import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

import { parseSkill } from './schema.js';
import type { Skill } from './schema.js';
import type { HealCandidate } from './types.js';

/** Persist a fully verified locator repair while retaining the YAML document's comments. */
export async function commitHeal(
  skillPath: string,
  candidate: HealCandidate,
  reason: string,
): Promise<Skill> {
  if (!candidate.resolveVerified || !candidate.actionVerified) {
    throw new Error('只有定位与动作均验证通过的自愈候选才能写回');
  }
  const source = await readFile(skillPath, 'utf8');
  const skill = parseSkill(source);
  const stepIndex = skill.steps.findIndex((step) => step.id === candidate.stepId);
  if (stepIndex < 0) throw new Error(`技能中不存在步骤: ${candidate.stepId}`);

  const document = parseDocument(source);
  document.setIn(['steps', stepIndex, 'ui', 'target'], candidate.newTarget);
  document.setIn(['skill', 'version'], skill.skill.version + 1);
  document.set('_healHistory', [
    ...(skill._healHistory ?? []),
    {
      at: new Date().toISOString(),
      step: candidate.stepId,
      reason,
      old: candidate.oldTarget,
      new: candidate.newTarget,
      verified: true,
      model: candidate.model,
    },
  ]);
  const yaml = document.toString({ lineWidth: 0 });
  const updated = parseSkill(yaml);
  await writeFile(skillPath, yaml, 'utf8');
  return updated;
}
