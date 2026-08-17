import { LocatorStrategySchema, RETRY } from '@dsh/core';
import type { HealCandidate, ILLMProvider, LocatorStrategy, Step } from '@dsh/core';
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
            '修复失败的页面定位器。target 只能使用 el-form-item、el-option、el-dialog-scoped、el-table-cell、text、role、css strategy。evidence 必须逐字引用快照中能证明目标语义的一整段文本。只返回 JSON，禁止建议或执行页面动作。',
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

function stepTarget(step: Step): LocatorStrategy | null {
  if (step.ui?.target) return step.ui.target;
  if (step.ui?.label && step.ui.kind) {
    return { strategy: 'el-form-item', label: step.ui.label, kind: step.ui.kind };
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
    case 'el-form-item': return [target.label];
    case 'el-option': return [target.ownerLabel, target.text];
    case 'el-dialog-scoped': return [target.dialogTitle, ...targetTerms(target.inner)];
    case 'el-table-cell': return [target.rowAnchorText, target.buttonText];
    case 'text': return [target.text];
    case 'role': return [target.name];
    case 'css': return [target.selector];
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
  return page.evaluate(({ strategy, actionName }) => {
    const visible = (element: Element): element is HTMLElement => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      return element.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const text = (value: string | null | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
    const controls = (item: Element, kind: string): HTMLElement[] => {
      const selector = kind === 'textarea' ? 'textarea'
        : kind === 'button' ? 'button, [role="button"]'
          : kind === 'select' ? '.el-select'
            : kind === 'radio' ? 'input[type="radio"], .el-radio'
              : kind === 'checkbox' ? 'input[type="checkbox"], .el-checkbox'
                : kind === 'text' ? 'input[readonly], span, p'
                  : 'input';
      return [...item.querySelectorAll(selector)].filter(visible);
    };
    const find = (current: LocatorStrategy, root: ParentNode): HTMLElement[] => {
      switch (current.strategy) {
        case 'el-form-item':
          return [...root.querySelectorAll('.el-form-item')]
            .filter(visible)
            .filter((item) => text(item.querySelector('.el-form-item__label')?.textContent) === text(current.label))
            .flatMap((item) => controls(item, current.kind));
        case 'el-option':
          return [...document.querySelectorAll('.el-select-dropdown__item')]
            .filter(visible)
            .filter((item) => text(item.textContent) === text(current.text));
        case 'el-dialog-scoped': {
          const dialogs = [...root.querySelectorAll('.el-dialog')]
            .filter(visible)
            .filter((dialog) => text(dialog.querySelector('.el-dialog__title')?.textContent) === text(current.dialogTitle));
          return dialogs.flatMap((dialog) => find(current.inner, dialog));
        }
        case 'el-table-cell': {
          const rows = [...root.querySelectorAll('.el-table__row')]
            .filter(visible)
            .filter((row) => text(row.textContent).includes(text(current.rowAnchorText)));
          return rows.flatMap((row) => [...row.querySelectorAll('button, [role="button"]')]
            .filter(visible)
            .filter((button) => text(button.textContent) === text(current.buttonText)));
        }
        case 'text':
          return [...root.querySelectorAll('button, a, label, span, p, h1, h2, h3, td')]
            .filter(visible)
            .filter((element) => current.exact === false
              ? text(element.textContent).includes(text(current.text))
              : text(element.textContent) === text(current.text));
        case 'role':
          return [...root.querySelectorAll(`[role="${CSS.escape(current.role)}"]`)]
            .filter(visible)
            .filter((element) => text(element.textContent) === text(current.name));
        case 'css':
          return [...root.querySelectorAll(current.selector)].filter(visible);
      }
    };
    const matches = find(strategy, document);
    if (matches.length !== 1) return false;
    const element = matches[0]!;
    if (element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true') return false;
    if (actionName === 'fill') return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
    if (actionName === 'setDateTime') return element instanceof HTMLInputElement;
    if (actionName === 'selectOption') return strategy.strategy === 'el-option' || element.classList.contains('el-select');
    if (actionName === 'click') {
      return element.matches('button, a, [role="button"], input[type="button"], input[type="submit"]');
    }
    return true;
  }, { strategy: target, actionName: action });
}
