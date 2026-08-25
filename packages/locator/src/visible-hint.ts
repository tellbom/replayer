import { getAriaRole, getElementAccessibleNameText } from '../../../vendor/playwright-injected/1.62.1/roleUtils';

type HintAction = 'click' | 'fill' | 'select' | 'check' | 'datetime' | 'navigate';
type HintSource =
  | 'accessible-name' | 'label' | 'aria' | 'placeholder' | 'title' | 'text'
  | 'control-semantics' | 'adjacent-text' | 'none';

interface ControlSemantics {
  tagName: string;
  type: string | null;
  name: string | null;
  value: string | null;
  checked: boolean | null;
}

export interface BrowserRecordedHint {
  action: HintAction;
  visibleText: string | null;
  visibleTextSource: HintSource;
  controlSemantics: ControlSemantics | null;
  tagName: string;
  role: string | null;
  matchCountAtRecord: number;
}

export function extractRecordedHint(
  element: Element,
  action: HintAction,
  matchCountAtRecord: number,
): BrowserRecordedHint {
  const controlSemantics = extractControlSemantics(element);
  const candidates: Array<[HintSource, string | null | undefined]> = [
    ['accessible-name', getElementAccessibleNameText(element, false)],
    ['label', associatedLabel(element)],
    ['aria', ariaText(element)],
    ['placeholder', element.getAttribute('placeholder')],
    ['title', element.getAttribute('title')],
    ['text', element.textContent?.slice(0, 60)],
    ['control-semantics', formatControlSemantics(controlSemantics)],
    ['adjacent-text', adjacentText(element)],
  ];
  const found = candidates.find(([, value]) => Boolean(value?.trim()));
  return {
    action,
    visibleText: found?.[1]?.trim() ?? null,
    visibleTextSource: found?.[0] ?? 'none',
    controlSemantics,
    tagName: element.tagName.toLowerCase(),
    role: getAriaRole(element),
    matchCountAtRecord,
  };
}

function extractControlSemantics(element: Element): ControlSemantics | null {
  const isCheckable =
    element instanceof HTMLInputElement && (element.type === 'radio' || element.type === 'checkbox');
  const isSelect = element instanceof HTMLSelectElement;
  const isOption = element instanceof HTMLOptionElement;
  if (!isCheckable && !isSelect && !isOption) return null;

  const owner = isOption ? element.closest('select') : element;
  return {
    tagName: element.tagName.toLowerCase(),
    type:
      element instanceof HTMLInputElement || element instanceof HTMLSelectElement
        ? element.type
        : null,
    name:
      owner instanceof HTMLInputElement || owner instanceof HTMLSelectElement
        ? owner.name || null
        : null,
    value:
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLOptionElement
        ? element.value || null
        : null,
    checked: isCheckable ? element.checked : null,
  };
}

function formatControlSemantics(semantics: ControlSemantics | null): string | null {
  if (!semantics) return null;
  const parts = [semantics.name, semantics.value].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(' = ') : null;
}

function adjacentText(element: Element): string | null {
  const siblingText = (start: Node | null, direction: 'previousSibling' | 'nextSibling') => {
    let node = start;
    while (node) {
      const value = node.textContent?.trim();
      if (value) return value.slice(0, 40);
      node = node[direction];
    }
    return null;
  };
  const previous = siblingText(element.previousSibling, 'previousSibling');
  if (previous) return previous;
  const next = siblingText(element.nextSibling, 'nextSibling');
  if (next) return next;

  const container = element.closest('label, fieldset, [role="group"]');
  if (!container) return null;
  const walker = element.ownerDocument.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  let node = walker.nextNode();
  while (node) {
    if (!element.contains(node)) {
      const value = node.textContent?.trim();
      if (value) parts.push(value);
    }
    node = walker.nextNode();
  }
  const value = parts.join(' ').replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 40) : null;
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
