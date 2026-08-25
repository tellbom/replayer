import { readFile, writeFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';

import { assertNoPersistedCredentialHeaders, parseSkill } from './schema.js';
import type { Entry, Skill } from './schema.js';
import type { HealCandidate } from './types.js';

/** Persist a fully verified locator repair while retaining the YAML document's comments. */
export async function commitHeal(
  skillPath: string,
  candidate: HealCandidate,
  reason: string,
  entryResolver: (id: string) => Entry,
): Promise<Skill> {
  if (!candidate.resolveVerified || !candidate.actionVerified) {
    throw new Error('只有定位与动作均验证通过的自愈候选才能写回');
  }
  const source = await readFile(skillPath, 'utf8');
  const skill = parseSkill(source, entryResolver);
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
  const updated = parseSkill(yaml, entryResolver);
  assertNoPersistedCredentialHeaders(updated);
  await writeFile(skillPath, yaml, 'utf8');
  return updated;
}

/** Persist the user-supervised verification state while retaining YAML comments. */
export async function writeSkillVerification(
  skillPath: string,
  verification: Skill['verification'],
): Promise<void> {
  const source = await readFile(skillPath, 'utf8');
  const document = parseDocument(source);
  document.set('verification', verification);
  const yaml = document.toString({ lineWidth: 0 });
  // 此写回入口没有 entryResolver；先机械扫描 header 值，完整 Schema 校验仍由加载时执行。
  const parsed = parseDocument(yaml).toJS() as Skill;
  assertNoPersistedCredentialHeaders(parsed);
  await writeFile(skillPath, yaml, 'utf8');
}
