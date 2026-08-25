import { renderLocatorQualitySummary } from '@dsh/analyzer';
import { writeSkillVerification } from '@dsh/core';
import type { RunResult, Skill, Step } from '@dsh/core';
import { refreshVerification } from '@dsh/replayer';
import type { LowTargetInspection } from '@dsh/replayer';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';

export interface VerificationPrompter {
  confirmSupervised(lowCount: number): Promise<boolean>;
  confirmUnverifiable(step: Step, inspection: LowTargetInspection): Promise<boolean>;
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
  confirmUnverifiable: (step, inspection) => askYesNo(
    `${renderLowTarget(step, inspection)}  This target has no comparable semantics. Continue? [y/N] `,
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
  const statusBeforeRefresh = skill.verification.status;
  const unverifiable = unverifiableLowSteps(skill);
  if (unverifiable.length > 0) {
    skill.verification.verifiedTtlDays = Math.min(skill.verification.verifiedTtlDays, 7);
    if (skill.verification.status === 'draft') {
      skill.verification.requiresFirstRunVerification = true;
    }
  }
  refreshVerification(skill);
  if (verificationState(skill) !== beforeRefresh) {
    await writeSkillVerification(skillPath, skill.verification);
    if (statusBeforeRefresh === 'verified' && skill.verification.status === 'draft') {
      process.stdout.write('The previous LOW verification expired; supervised verification is required again.\n');
    }
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
    if (dryRun) process.stdout.write(renderLocatorQualitySummary(skill));
    return { proceed: true, supervised: false, stateBeforeRun };
  }

  process.stdout.write(renderLowRiskList(lowSteps));
  if (unverifiable.length > 0) {
    process.stdout.write(
      `This skill contains ${unverifiable.length} LOW step(s) with no comparable semantics. `
      + 'Supervised verification will pause before each such action.\n',
    );
  }
  const proceed = await prompter.confirmSupervised(lowSteps.length);
  if (!proceed) {
    process.stdout.write('Supervised verification cancelled; the skill remains draft. Re-record before unattended use.\n');
  }
  return { proceed, supervised: proceed, stateBeforeRun };
}

export function createLowTargetObserver(
  supervised: boolean,
  prompter: VerificationPrompter,
): (step: Step, inspection: LowTargetInspection) => Promise<boolean> {
  return async (step, inspection) => {
    process.stdout.write(renderLowTarget(step, inspection));
    if (!supervised || !inspection.unverifiable) return true;
    return prompter.confirmUnverifiable(step, inspection);
  };
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

function renderLowTarget(step: Step, inspection: LowTargetInspection): string {
  const recorded = renderHint(inspection.recorded);
  const current = renderHint(inspection.current);
  const consistent = recorded === current;
  const attributes = Object.entries(inspection.element.attributes)
    .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
    .join(' ');
  const box = inspection.element.box;
  return [
    `Step ${step.id} · ${step.desc}`,
    `  Locator: positional ${JSON.stringify(step.ui?.target ?? null)}`,
    `  Recorded target: ${recorded}`,
    `  Current target:  ${current} ${consistent ? '✓ consistent' : '✗ mismatch'}`,
    `  Element: <${inspection.element.tagName}> text=${inspection.element.text ?? '(empty)'}`,
    `  Attributes: ${attributes || '(none)'}`,
    `  Position: ${box ? `(x=${round(box.x)}, y=${round(box.y)}, w=${round(box.width)}, h=${round(box.height)})` : '(not rendered)'}`,
  ].join('\n') + '\n';
}

function renderHint(hint: LowTargetInspection['recorded']): string {
  const semantics = hint.controlSemantics;
  if (semantics) {
    return `${hint.visibleText ?? '(no text)'} (${semantics.name ?? '(no name)'}=${semantics.value ?? '(no value)'}, type=${semantics.type ?? '(none)'})`;
  }
  return hint.visibleText ?? '(no comparable semantics)';
}

function unverifiableLowSteps(skill: Skill): Skill['steps'] {
  return skill.steps.filter((step) => {
    const target = step.ui?.target;
    const hint = step.ui?.recordedHint;
    return Boolean(
      target
      && 'confidence' in target
      && target.confidence === 'LOW'
      && (!hint || (hint.controlSemantics === null && hint.visibleText === null)),
    );
  });
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
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
