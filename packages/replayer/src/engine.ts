import { ensureLoggedIn, launchDSHContext } from '@dsh/browser';
import { StepExecutionError } from '@dsh/core';
import type { ExecContext, RunResult, Skill, Step } from '@dsh/core';

import { executePreflights } from './preflight.js';
import { executeNetworkStep } from './channel-network.js';
import { executeUiStep } from './channel-ui.js';

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
    const executionContext: ExecContext = {
      params: opts.params,
      vars: {},
      stepResults: {},
      baseUrl: skill.skill.baseUrl,
    };
    await executePreflights(page, skill.preflight, executionContext);
    const stepResults = [];
    for (const step of skill.steps) {
      if (step.hasSideEffect && opts.onConfirm) {
        const confirmed = await opts.onConfirm(step, executionContext);
        if (!confirmed) {
          stepResults.push({
            stepId: step.id,
            ok: false,
            outcome: 'not_sent' as const,
            channelUsed: 'network' as const,
            durationMs: 0,
            error: '用户取消执行',
          });
          break;
        }
      }
      const channel = opts.forceChannel ?? step.channel;
      if (channel === 'ui' && step.ui) {
        const result = await executeUiStep(page, step, executionContext, skill.params);
        stepResults.push(result);
        continue;
      }
      if (channel !== 'network' || !step.network) {
        throw new StepExecutionError(`当前任务尚未支持通道: ${channel}`);
      }
      const result = await executeNetworkStep(page, step, executionContext, skill.params);
      stepResults.push(result);
      if (!result.ok) break;
    }
    return {
      ok: stepResults.every((result) => result.ok),
      skillId: skill.skill.id,
      steps: stepResults,
      extracted: executionContext.vars,
    };
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
