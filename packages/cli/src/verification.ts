import { writeSkillVerification } from '@dsh/core';
import type { RunResult, Skill } from '@dsh/core';
import { refreshVerification } from '@dsh/replayer';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

export interface VerificationPrompter {
  confirmSupervised(lowCount: number): Promise<boolean>;
  confirmComplete(): Promise<boolean>;
}

export interface VerificationSession {
  proceed: boolean;
  supervised: boolean;
  stateBeforeRun: string;
}

export const terminalVerificationPrompter: VerificationPrompter = {
  confirmSupervised: (lowCount) => askYesNo(
    `This skill contains ${lowCount} LOW-confidence locators. Run supervised verification? [y/N] `,
  ),
  confirmComplete: () => askYesNo('Was the complete run correct? [y/N] '),
};

export async function prepareVerification(
  skill: Skill,
  skillPath: string,
  prompter: VerificationPrompter,
  dryRun = false,
): Promise<VerificationSession> {
  const beforeRefresh = verificationState(skill);
  refreshVerification(skill);
  if (verificationState(skill) !== beforeRefresh) {
    await writeSkillVerification(skillPath, skill.verification);
    process.stdout.write('The previous LOW verification expired; supervised verification is required again.\n');
  }
  const stateBeforeRun = verificationState(skill);
  const lowSteps = skill.steps.filter((step) => {
    const target = step.ui?.target;
    return target && 'confidence' in target && target.confidence === 'LOW';
  });
  if (
    dryRun
    || lowSteps.length === 0
    || skill.verification.status !== 'draft'
    || !skill.verification.requiresFirstRunVerification
  ) {
    return { proceed: true, supervised: false, stateBeforeRun };
  }

  process.stdout.write(renderLowRiskList(lowSteps));
  const proceed = await prompter.confirmSupervised(lowSteps.length);
  if (!proceed) {
    process.stdout.write('Supervised verification cancelled; the skill remains draft. Re-record before unattended use.\n');
  }
  return { proceed, supervised: proceed, stateBeforeRun };
}

export async function finishVerification(
  skill: Skill,
  skillPath: string,
  session: VerificationSession,
  result: RunResult | undefined,
  prompter: VerificationPrompter,
): Promise<void> {
  if (session.supervised && result?.ok) {
    if (await prompter.confirmComplete()) {
      skill.verification.status = 'verified';
      skill.verification.requiresFirstRunVerification = false;
      skill.verification.verifiedAt = new Date().toISOString();
      skill.verification.verifiedRunId = randomUUID();
      skill.verification.rerecordReason = null;
      process.stdout.write('LOW locator verification passed; the skill is now verified.\n');
    } else {
      process.stdout.write('The skill remains draft. Re-record the incorrect flow before unattended use.\n');
    }
  }
  if (verificationState(skill) !== session.stateBeforeRun) {
    await writeSkillVerification(skillPath, skill.verification);
  }
}

function renderLowRiskList(lowSteps: Skill['steps']): string {
  const lines = ['LOW-confidence locator review:'];
  for (const step of lowSteps) {
    const hint = step.ui?.recordedHint;
    lines.push(
      `  - ${step.id}: ${step.desc}; recorded text=${hint?.visibleText ?? '(none)'}; target=${JSON.stringify(step.ui?.target)}`,
    );
  }
  lines.push('Press Ctrl+C now to stop without executing any action.');
  return `${lines.join('\n')}\n`;
}

function verificationState(skill: Skill): string {
  return JSON.stringify(skill.verification);
}

async function askYesNo(question: string): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await prompt.question(question)).trim().toLowerCase() === 'y';
  } finally {
    prompt.close();
  }
}
