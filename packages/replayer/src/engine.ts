import { ensureLoggedIn, launchDSHContext } from '@dsh/browser';
import { StepExecutionError } from '@dsh/core';
import type { ExecContext, RunResult, Skill, Step } from '@dsh/core';

export interface ReplayOptions {
  // 冻结契约允许任意参数值。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  profileDir: string;
  dryRun?: boolean;
  forceChannel?: 'ui' | 'network';
  noLLM?: boolean;
  onConfirm?: (step: Step, context: ExecContext) => Promise<boolean>;
}

/** 回放统一入口；各执行器按任务顺序接入此编排。 */
export async function replay(skill: Skill, opts: ReplayOptions): Promise<RunResult> {
  if (opts.dryRun) {
    process.stdout.write(renderExecutionPlan(skill, opts));
    return { ok: true, skillId: skill.skill.id, steps: [], extracted: {} };
  }

  const context = await launchDSHContext({ profileDir: opts.profileDir });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(skill.auth?.probeUrl ?? skill.skill.baseUrl);
    if (skill.auth) await ensureLoggedIn(page, skill.auth);
    if (skill.preflight.length > 0 || skill.steps.length > 0) {
      throw new StepExecutionError('回放执行器尚未接入当前编排');
    }
    return { ok: true, skillId: skill.skill.id, steps: [], extracted: {} };
  } finally {
    await context.close();
  }
}

export function renderExecutionPlan(skill: Skill, opts: ReplayOptions): string {
  const lines = [
    `DSH dry-run: ${skill.skill.id}`,
    `baseUrl: ${skill.skill.baseUrl}`,
    `profile: ${opts.profileDir}`,
    `channel: ${opts.forceChannel ?? 'skill'}`,
    `LLM: ${opts.noLLM ? 'disabled' : 'enabled'}`,
    '预取:',
  ];
  if (skill.preflight.length === 0) lines.push('  无');
  else skill.preflight.forEach((item) => lines.push(`  - ${item.name}: ${item.extract.type}`));
  lines.push('步骤:');
  if (skill.steps.length === 0) lines.push('  无');
  else {
    skill.steps.forEach((step) => {
      const channel = opts.forceChannel ?? step.channel;
      lines.push(
        `  - ${step.id} [${channel}/${step.riskLevel}] ${step.desc}${step.hasSideEffect ? ' [side-effect]' : ''}`,
      );
    });
  }
  lines.push('断言:');
  if (skill.assertions.length === 0) lines.push('  无');
  else skill.assertions.forEach((assertion) => lines.push(`  - ${assertion.type}`));
  lines.push(`postcondition: ${skill.postcondition ? skill.postcondition.request.url : '无'}`);
  return `${lines.join('\n')}\n`;
}
