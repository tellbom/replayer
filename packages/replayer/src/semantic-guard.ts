import { SemanticDriftError } from '@dsh/core';
import type { RecordedHint } from '@dsh/core';
import type { Locator } from 'playwright';

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
  if (hint.visibleText === null) return;
  const current = await locator.evaluate(
    (element, input) => window.__DSH_EXTRACT_RECORDED_HINT__(element, input.action, 1),
    hint,
  );
  if (
    current.visibleText !== null &&
    normalizeVisibleText(current.visibleText) === normalizeVisibleText(hint.visibleText)
  ) return;
  throw new SemanticDriftError(stepId, hint.visibleText, current.visibleText ?? '（无可识别文本）');
}
