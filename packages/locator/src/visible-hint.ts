import { getAriaRole, getElementAccessibleNameText } from '../../../vendor/playwright-injected/1.62.1/roleUtils';

type HintAction = 'click' | 'fill' | 'select' | 'check' | 'datetime' | 'navigate';
type HintSource =
  | 'accessible-name' | 'label' | 'aria' | 'placeholder' | 'title' | 'text' | 'none';

export interface BrowserRecordedHint {
  action: HintAction;
  visibleText: string | null;
  visibleTextSource: HintSource;
  tagName: string;
  role: string | null;
  matchCountAtRecord: number;
}

export function extractRecordedHint(
  element: Element,
  action: HintAction,
  matchCountAtRecord: number,
): BrowserRecordedHint {
  const candidates: Array<[HintSource, string | null | undefined]> = [
    ['accessible-name', getElementAccessibleNameText(element, false)],
    ['label', associatedLabel(element)],
    ['aria', ariaText(element)],
    ['placeholder', element.getAttribute('placeholder')],
    ['title', element.getAttribute('title')],
    ['text', element.textContent?.slice(0, 60)],
  ];
  const found = candidates.find(([, value]) => Boolean(value?.trim()));
  return {
    action,
    visibleText: found?.[1]?.trim() ?? null,
    visibleTextSource: found?.[0] ?? 'none',
    tagName: element.tagName.toLowerCase(),
    role: getAriaRole(element),
    matchCountAtRecord,
  };
}

function associatedLabel(element: Element): string | null {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return [...(element.labels ?? [])].map((label) => label.textContent ?? '').join(' ').trim() || null;
  }
  return null;
}

function ariaText(element: Element): string | null {
  const direct = element.getAttribute('aria-label')?.trim();
  if (direct) return direct;
  const ids = element.getAttribute('aria-labelledby')?.split(/\s+/).filter(Boolean) ?? [];
  const text = ids
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
    .join(' ')
    .trim();
  return text || null;
}

Object.assign(window, { __DSH_EXTRACT_RECORDED_HINT__: extractRecordedHint });
