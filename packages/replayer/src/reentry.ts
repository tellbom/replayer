import {
  IdentityChangedError,
  OutcomeUnknownError,
  stepIsIdempotent,
  type Entry,
  type ExecContext,
  type Postcondition,
  type Skill,
  type Step,
  type StepResult,
} from '@dsh/core';
import { readIdentityDigest, recoverEntryAuthentication } from '@dsh/browser';
import type { Page } from 'playwright';

export interface ReentryDecision {
  action: 'retry-step' | 'skip-step' | 'restart-from-anchor' | 'abort';
  result?: StepResult;
  reason: string;
}

/**
 * 【T-59 / C14+C21+C22】会话失效时的重入决策。
 * 只恢复认证（C14）；身份校验（C21）；重跑=从 anchor 的幂等前缀重来（C22），
 * 绝不「记录断点从那继续」——重新登录后表单值、弹窗态、联动结果全部丢失。
 * postcondition 执行器由调用方注入，避免与 engine 的循环依赖。
 */
export async function decideReentry(
  input: {
    page: Page;
    skill: Skill;
    step: Step;
    context: ExecContext;
    interrupted: StepResult;
    reentryCount: number;
  },
  runPostcondition: (
    page: Page,
    postcondition: Postcondition,
    context: ExecContext,
  ) => Promise<{ found: boolean; expectFound: boolean }>,
): Promise<ReentryDecision> {
  const { page, skill, step, context, interrupted, reentryCount } = input;
  const reentry = skill.reentry;

  // 1. 恢复认证——不重放任何业务动作
  await recoverEntryAuthentication(page, context.entry);

  // 2. 【C21】身份一致性
  if (reentry?.identityLock !== false) {
    const after = await readIdentityDigest(page, context.entry);
    if (after !== context.identityDigest) {
      throw new IdentityChangedError(
        `认证恢复后身份变更：${context.identityDigest.slice(0, 12)} → ${after.slice(0, 12)}，拒绝继续`,
      );
    }
  }

  // 3. 重入次数上限
  const max = reentry?.maxReentries ?? 0;
  if (reentryCount >= max) {
    return { action: 'abort', reason: `重入次数已达上限 ${max}` };
  }

  // 4. 【C22】按中断步骤性质分流
  if (stepIsIdempotent(step)) {
    return { action: 'retry-step', reason: '中断步骤幂等，恢复后安全重跑' };
  }

  // 写步骤：请求可能已到服务端 → 必须先 postcondition 确认
  const postcondition: Postcondition | undefined = step.postcondition ?? skill.postcondition;
  if (interrupted.outcome === 'outcome_unknown') {
    if (!postcondition) {
      throw new OutcomeUnknownError(
        `步骤 ${step.id} 会话失效且响应未知，无 postcondition 可确认，中止`,
      );
    }
    const resolution = await runPostcondition(page, postcondition, context);
    if (resolution.found === resolution.expectFound) {
      return {
        action: 'skip-step',
        result: {
          ...interrupted,
          ok: true,
          outcome: 'confirmed_success',
          outcomeResolvedBy: 'postcondition',
          postconditionResult: resolution,
        },
        reason: 'postcondition 确认服务端已成功，跳过该步骤',
      };
    }
    // 确认未成功 → 从 anchor 重跑
    return { action: 'restart-from-anchor', reason: 'postcondition 确认未成功，从 anchor 重跑' };
  }

  // 写步骤但明确未发出（not_sent）→ 与幂等同理可安全重跑本步
  if (interrupted.outcome === 'not_sent') {
    return { action: 'retry-step', reason: '请求未发出，恢复后安全重跑' };
  }

  return { action: 'restart-from-anchor', reason: '结果不可判定，从 anchor 重跑' };
}

/** 【C22】重跑前清空 anchor 之后所有派生状态（新会话中它们全部作废）。 */
export function resetContextAfterAnchor(context: ExecContext, skill: Skill): void {
  const anchor = skill.reentry?.anchor;
  if (!anchor) return;
  const idx = skill.steps.findIndex((s) => s.id === anchor);
  if (idx < 0) return;
  for (const step of skill.steps.slice(idx + 1)) {
    delete context.stepResults[step.id];
    delete context.vars[step.id];
  }
}

export type { Entry, ExecContext, Skill, Step, StepResult };
