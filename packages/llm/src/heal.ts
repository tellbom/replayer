import { commitHeal, LocatorStrategySchema, RETRY } from '@dsh/core';
import type { ExecContext, HealCandidate, ILLMProvider, LocatorStrategy, Skill, Step, StepResult } from '@dsh/core';
import { executePostcondition, executeUiStep, runAssertions } from '@dsh/replayer';
import type { Page } from 'playwright';
import { z } from 'zod';

import { chatJSON } from './guard.js';

const HealResponseSchema = z.object({
  target: LocatorStrategySchema,
  evidence: z.string().min(1),
});

export interface ProposeHealContext {
  llm: ILLMProvider;
  page: Page;
  step: Step;
  error: Error;
  snapshot: string;
}

export interface ExecuteHealContext {
  page: Page;
  skill: Skill;
  skillPath: string;
  candidate: HealCandidate;
  context: ExecContext;
  reason: string;
  onConfirm?: (step: Step, context: ExecContext) => Promise<boolean>;
  assertionRaw?: StepResult['raw'];
}

/** Propose and verify a replacement locator without executing the associated action. */
export async function proposeHeal(ctx: ProposeHealContext): Promise<HealCandidate | null> {
  const oldTarget = stepTarget(ctx.step);
  if (!oldTarget || !ctx.step.ui) return null;
  const snapshot = ctx.snapshot || await ctx.page.evaluate(() => window.__DSH_SNAPSHOT__());

  for (let attempt = 0; attempt < RETRY.healMax; attempt += 1) {
    const response = await chatJSON(
      ctx.llm,
      [
        {
          role: 'system',
          content:
            '修复失败的页面定位器。target 只能使用 label、text、role、css 或 playwright strategy。evidence 必须逐字引用快照中能证明目标语义的一整段文本。只返回 JSON，禁止建议或执行页面动作。',
        },
        {
          role: 'user',
          content: JSON.stringify({
            originalTarget: oldTarget,
            error: ctx.error.message,
            goal: ctx.step.desc,
            action: ctx.step.ui.action,
            snapshot,
          }),
        },
      ],
      HealResponseSchema,
    );
    if (!snapshot.includes(response.evidence)) continue;
    if (!semanticEvidenceMatches(response.target, response.evidence)) continue;
    if (!await resolveOnly(ctx.page, response.target, ctx.step.ui.action)) continue;
    return {
      stepId: ctx.step.id,
      oldTarget,
      newTarget: response.target,
      resolveVerified: true,
      actionVerified: false,
      requiresConfirm: ctx.step.riskLevel !== 'read' || ctx.step.hasSideEffect,
      model: ctx.llm.name,
    };
  }
  return null;
}

/** Confirm, execute, verify and finally persist a resolve-verified repair. */
export async function executeHeal(ctx: ExecuteHealContext): Promise<HealCandidate | null> {
  if (!ctx.candidate.resolveVerified || ctx.candidate.actionVerified) {
    throw new Error('自愈执行要求仅完成定位验证的候选');
  }
  const original = ctx.skill.steps.find((step) => step.id === ctx.candidate.stepId);
  if (!original?.ui) throw new Error(`技能中不存在可执行的 UI 步骤: ${ctx.candidate.stepId}`);
  const requiresConfirm = original.riskLevel !== 'read' || original.hasSideEffect;
  if (ctx.candidate.requiresConfirm !== requiresConfirm) {
    throw new Error('自愈候选的确认标记与步骤风险不一致');
  }
  if (requiresConfirm) {
    const accepted = ctx.onConfirm ? await ctx.onConfirm(original, ctx.context) : false;
    if (!accepted) return null;
  }
  const healedStep: Step = {
    ...original,
    ui: { ...original.ui, target: ctx.candidate.newTarget },
  };
  const result = await executeUiStep(ctx.page, healedStep, ctx.context, ctx.skill.params);
  if (!result.ok) return null;

  const postcondition = original.postcondition ?? ctx.skill.postcondition;
  if (original.hasSideEffect) {
    if (!postcondition) throw new Error(`副作用步骤 ${original.id} 缺少 postcondition`);
    const resolution = await executePostcondition(ctx.page, postcondition, ctx.context, ctx.skill.params);
    if (resolution.found !== resolution.expectFound) return null;
  }
  if (ctx.assertionRaw) {
    runAssertions(ctx.skill.assertions, ctx.assertionRaw, ctx.context);
  }
  const verified = { ...ctx.candidate, actionVerified: true };
  await commitHeal(ctx.skillPath, verified, ctx.reason, (id: string) => {
    if (id !== ctx.context.entry.entry.id) throw new Error(`entry 配置不存在: ${id}`);
    return ctx.context.entry;
  });
  return verified;
}

function stepTarget(step: Step): LocatorStrategy | null {
  if (step.ui?.target) return step.ui.target;
  if (step.ui?.label && step.ui.kind) {
    return { strategy: 'label', label: step.ui.label, kind: step.ui.kind };
  }
  return null;
}

function semanticEvidenceMatches(target: LocatorStrategy, evidence: string): boolean {
  if (target.strategy === 'css') return true;
  const terms = targetTerms(target).map(normalize).filter(Boolean);
  const normalizedEvidence = normalize(evidence);
  return terms.some((term) => normalizedEvidence.includes(term));
}

function targetTerms(target: LocatorStrategy): string[] {
  switch (target.strategy) {
    case 'label': return [target.label];
    case 'text': return [target.text];
    case 'role': return [target.name];
    case 'css': return [target.selector];
    case 'playwright': return [target.selector];
    case 'frame-playwright': return [target.frame, target.selector];
    default:
      return Object.values(target).flatMap((value) => typeof value === 'string' ? [value] : []);
  }
}

function normalize(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

async function resolveOnly(
  page: Page,
  target: LocatorStrategy,
  action: NonNullable<Step['ui']>['action'],
): Promise<boolean> {
  return page.evaluate(async ({ strategy, actionName }) => {
    if (strategy.strategy === 'playwright' || strategy.strategy === 'frame-playwright') return false;
    const element = await window.__DSH_LOCATOR__.resolve(strategy);
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
    if (actionName === 'fill') return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    if (actionName === 'setDateTime') return element instanceof HTMLInputElement;
    if (actionName === 'selectOption') {
      return element instanceof HTMLSelectElement || element.getAttribute('role') === 'combobox';
    }
    if (actionName === 'click') {
      return element.matches('button, a, [role="button"], input[type="button"], input[type="submit"]');
    }
    return true;
  }, { strategy: target, actionName: action });
}
