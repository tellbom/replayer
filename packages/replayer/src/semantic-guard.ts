import { SemanticDriftError } from '@dsh/core';
import type { RecordedHint } from '@dsh/core';
import type { Locator } from 'playwright';

export interface LowTargetInspection {
  recorded: RecordedHint;
  current: RecordedHint;
  element: {
    tagName: string;
    text: string | null;
    attributes: Record<string, string>;
    box: { x: number; y: number; width: number; height: number } | null;
  };
  unverifiable: boolean;
}

export function normalizeVisibleText(value: string): string {
  return value
    .trim()
    .replace(/[！-～]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
    .replace(/[*＊:：?？]/g, ' ')
    .replace(/([\p{Script=Han}])\s+(?=[\p{Script=Han}])/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export async function assertLowSemantic(
  locator: Locator,
  hint: RecordedHint,
  stepId: string,
): Promise<void> {
  const inspection = await inspectLowTarget(locator, hint);
  assertLowInspection(inspection, stepId);
}

export async function inspectLowTarget(
  locator: Locator,
  hint: RecordedHint,
): Promise<LowTargetInspection> {
  const current = await locator.evaluate(
    (element, input) => window.__DSH_EXTRACT_RECORDED_HINT__(element, input.action, 1),
    hint,
  );
  const element = await locator.evaluate((node) => {
    const allowed = ['id', 'class', 'name', 'type', 'role', 'aria-label', 'title'];
    const attributes = Object.fromEntries(
      allowed.flatMap((name) => {
        const value = node.getAttribute(name);
        return value === null ? [] : [[name, value]];
      }),
    );
    const rect = node.getBoundingClientRect();
    return {
      tagName: node.tagName.toLowerCase(),
      text: node.textContent?.trim().slice(0, 80) || null,
      attributes,
      box: rect.width || rect.height
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
        : null,
    };
  });
  return {
    recorded: hint,
    current,
    element,
    unverifiable: hint.controlSemantics === null && hint.visibleText === null,
  };
}

export function assertLowInspection(inspection: LowTargetInspection, stepId: string): void {
  const { recorded: hint, current } = inspection;
  if (hint.controlSemantics) {
    const keys = ['name', 'value', 'type'] as const;
    const mismatch = keys.find(
      (key) => current.controlSemantics?.[key] !== hint.controlSemantics?.[key],
    );
    if (mismatch) {
      throw new SemanticDriftError(
        stepId,
        formatSemantics(hint.controlSemantics),
        formatSemantics(current.controlSemantics),
      );
    }
  }
  if (hint.visibleText === null) return;
  if (
    current.visibleText !== null &&
    normalizeVisibleText(current.visibleText) === normalizeVisibleText(hint.visibleText)
  ) return;
  throw new SemanticDriftError(stepId, hint.visibleText, current.visibleText ?? '（无可识别文本）');
}

function formatSemantics(value: RecordedHint['controlSemantics']): string {
  if (!value) return '（非标准表单控件）';
  return `${value.name ?? '（无 name）'} = ${value.value ?? '（无 value）'} [${value.type ?? '无 type'}]`;
}
