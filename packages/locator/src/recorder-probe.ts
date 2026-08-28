let openSelectLabel: string | null = null;
let nextActionIdx = 0;
const clickedElements: Record<number, Element> = {};
Reflect.set(window, '__dsh_clicked__', clickedElements);

interface BrowserActiveAction {
  actionIdx: number;
  targetKey: string;
  target: unknown;
  kind: 'input' | 'click' | 'select' | 'check';
  value: string | null;
  startedAt: number;
  touchedAt: number;
  blurAt: number | null;
}

let activeAction: BrowserActiveAction | null = null;
Reflect.set(window, '__DSH_ACTIVE_ACTION__', activeAction);

function pushActiveAction(): void {
  Reflect.set(window, '__DSH_ACTIVE_ACTION__', activeAction);
  const update = Reflect.get(window, '__DSH_ACTIVE_ACTION_UPDATE__');
  if (typeof update === 'function') {
    void Promise.resolve(update(activeAction)).catch(() => undefined);
  }
}

pushActiveAction();

function targetKey(element: Element): string {
  const container = element.closest('form, fieldset, [role="group"], [role="radiogroup"]')
    ?? document.body
    ?? document.documentElement;
  const tagName = element.tagName.toLowerCase();
  const name = element.getAttribute('name') ?? '';
  const type = element.getAttribute('type') ?? '';
  const peers = [...container.querySelectorAll(tagName)].filter(
    (candidate) =>
      (candidate.getAttribute('name') ?? '') === name
      && (candidate.getAttribute('type') ?? '') === type,
  );
  return `${tagName}|${name}|${type}|${Math.max(0, peers.indexOf(element))}`;
}

function ensureInitialNavigation(): void {
  if (initialNavigationEmitted) return;
  const record = Reflect.get(window, '__DSH_RECORD__');
  if (typeof record !== 'function') return;
  initialNavigationEmitted = true;
  record({ ts: Date.now(), actionIdx: nextActionIdx, type: 'navigate', url: location.href });
  nextActionIdx += 1;
}

function beginActiveAction(
  element: Element,
  kind: BrowserActiveAction['kind'],
  value: string | null,
  target: unknown,
  reuseInput = false,
): BrowserActiveAction {
  ensureInitialNavigation();
  const key = targetKey(element);
  const now = Date.now();
  if (reuseInput && activeAction?.kind === 'input' && activeAction.targetKey === key) {
    activeAction = { ...activeAction, target, value, touchedAt: now, blurAt: null };
    pushActiveAction();
    return activeAction;
  }
  activeAction = {
    actionIdx: nextActionIdx,
    targetKey: key,
    target,
    kind,
    value,
    startedAt: now,
    touchedAt: now,
    blurAt: null,
  };
  nextActionIdx += 1;
  clickedElements[activeAction.actionIdx] = element;
  const mutation = Reflect.get(window, '__DSH_MUTATION__') as { begin?: (idx: number) => void };
  mutation.begin?.(activeAction.actionIdx);
  pushActiveAction();
  return activeAction;
}

function recordWithActionIdx(
  actionIdx: number,
  action: Record<string, unknown>,
  activeStartedAt?: number,
): void {
  const record = Reflect.get(window, '__DSH_RECORD__');
  if (typeof record === 'function') {
    record({ ts: Date.now(), actionIdx, activeStartedAt, ...action });
  }
}

function emit(
  action: Record<string, unknown>,
  clickedElement?: Element,
  kind?: BrowserActiveAction['kind'],
): void {
  if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
  if (action.type === 'navigate') {
    if (!initialNavigationEmitted) {
      ensureInitialNavigation();
    } else {
      activeAction = null;
      pushActiveAction();
      recordWithActionIdx(nextActionIdx++, action);
    }
    return;
  }
  ensureInitialNavigation();
  const value = typeof action.value === 'string' ? action.value : null;
  const active = clickedElement && kind
    ? beginActiveAction(clickedElement, kind, value, action.target)
    : null;
  const actionIdx = active?.actionIdx ?? nextActionIdx++;
  recordWithActionIdx(actionIdx, action, active?.startedAt);
}

function generator(element: Element): unknown {
  const pwgen = Reflect.get(window, '__DSH_PWGEN__');
  if (typeof pwgen !== 'function') throw new Error('Playwright locator generator 未注入');
  const generated = pwgen(element) as {
    selector: string;
    unique: boolean;
    matchCount: number;
    confidence: 'HIGH' | 'LOW';
  };
  return {
    strategy: 'playwright',
    selector: generated.selector,
    confidence: generated.confidence,
    matchCount: generated.matchCount,
  };
}

function targetWithHint(
  action: 'click' | 'fill' | 'select' | 'check' | 'datetime' | 'navigate',
  element: Element,
): { target: unknown; recordedHint: unknown } {
  const generated = generator(element) as ({ matchCount?: number } & Record<string, unknown>) | undefined;
  const { matchCount = 0, ...target } = generated ?? {};
  const extractHint = Reflect.get(window, '__DSH_EXTRACT_RECORDED_HINT__') as (
    targetElement: Element,
    actionName: typeof action,
    count: number,
  ) => unknown;
  return {
    target,
    recordedHint: extractHint(element, action, matchCount),
  };
}

function labelFor(element: Element): string | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    const direct = [...(element.labels ?? [])].map((label) => label.textContent?.trim()).find(Boolean);
    if (direct) return direct;
  }
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
  return element.getAttribute('aria-label')?.trim() || labelledBy || undefined;
}

function semanticFieldLabel(element: Element): string | undefined {
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
    const labels = [...(element.labels ?? [])].map((label) => label.textContent?.trim()).filter(Boolean);
    if (labels.length > 0) return labels.join(' ');
  }
  const group = element.closest('fieldset, [role="group"], [role="radiogroup"]');
  return group?.querySelector('legend')?.textContent?.trim()
    ?? group?.getAttribute('aria-label')?.trim()
    ?? element.getAttribute('name')?.trim()
    ?? undefined;
}

function adjacentOptionText(element: Element): string | undefined {
  const label = element.closest('label')?.textContent?.trim();
  if (label) return label;
  for (const sibling of [element.previousElementSibling, element.nextElementSibling]) {
    const text = sibling?.textContent?.trim();
    if (text) return text;
  }
  return undefined;
}

function capturedEnumOptions(
  items: Array<{ label: string; value: string }>,
  incompleteReason?: 'dynamic-loading' | 'partial-dom',
): {
  items: Array<{ label: string; value: string }>;
  complete: boolean;
  incompleteReason?: 'truncated' | 'dynamic-loading' | 'partial-dom';
} {
  const maxOptions = Number(Reflect.get(window, '__DSH_ENUM_MAX_OPTIONS__'));
  if (!Number.isInteger(maxOptions) || maxOptions <= 0) {
    return { items: [], complete: false, incompleteReason: 'partial-dom' };
  }
  if (items.length > maxOptions) {
    return {
      items: items.slice(0, maxOptions),
      complete: false,
      incompleteReason: 'truncated',
    };
  }
  return incompleteReason
    ? { items, complete: false, incompleteReason }
    : { items, complete: true };
}

function roleOptionSet(option: Element): ReturnType<typeof capturedEnumOptions> | undefined {
  const owner = option.closest('[role="listbox"]');
  if (!owner) return undefined;
  const options = [...owner.querySelectorAll('[role="option"]')];
  if (options.length === 0) return undefined;
  const declaredSize = Math.max(...options.map((item) => Number(item.getAttribute('aria-setsize')) || 0));
  const incompleteReason = owner.getAttribute('aria-busy') === 'true'
    ? 'dynamic-loading'
    : declaredSize > options.length
      ? 'partial-dom'
      : undefined;
  return capturedEnumOptions(options.map((item) => {
    const label = item.getAttribute('aria-label')?.trim() || item.textContent?.trim() || '';
    return { label, value: item.getAttribute('value') ?? label };
  }), incompleteReason);
}

document.addEventListener(
  'click',
  (event) => {
    if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const standardOption = target.closest('[role="option"]');
    if (standardOption) {
      const text = standardOption.getAttribute('aria-label')?.trim()
        || standardOption.textContent?.trim()
        || '';
      emit({
        type: 'select',
        label: openSelectLabel,
        value: standardOption.getAttribute('value') ?? text,
        text,
        enumOptions: roleOptionSet(standardOption),
        ...targetWithHint('select', standardOption),
      }, standardOption, 'select');
      openSelectLabel = null;
      return;
    }

    const select = nearbyCombobox(target);
    if (select) {
      const combobox = select.matches('[role="combobox"]') ? select : select.querySelector('[role="combobox"]') ?? select;
      openSelectLabel = labelFor(combobox) ?? null;
      emit({
        type: 'click',
        label: openSelectLabel ?? undefined,
        text: openSelectLabel ?? undefined,
        ...targetWithHint('click', combobox),
      }, combobox, 'click');
      return;
    }

    const interactive = target.closest('button, [role="button"], a');
    if (interactive) {
      // 【T-68】每个动作持有独立 oracle，异步消歧不会被后续点击覆盖。
      emit(
        { type: 'click', text: interactive.textContent?.trim(), ...targetWithHint('click', interactive) },
        interactive,
        'click',
      );
    }
  },
  true,
);

function nearbyCombobox(target: Element): Element | null {
  const direct = target.closest('[role="combobox"], [aria-haspopup="listbox"]');
  if (direct) return direct;
  let ancestor: Element | null = target;
  for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
    if (ancestor.matches('form, main, body')) break;
    const candidate = ancestor.querySelector('[role="combobox"]');
    if (candidate) return candidate;
  }
  return null;
}

function isTextInput(element: EventTarget | null): element is HTMLInputElement | HTMLTextAreaElement {
  if (element instanceof HTMLTextAreaElement) return true;
  if (!(element instanceof HTMLInputElement)) return false;
  return !['button', 'checkbox', 'file', 'hidden', 'radio', 'reset', 'submit'].includes(element.type);
}

document.addEventListener(
  'input',
  (event) => {
    if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
    const target = event.target;
    if (!isTextInput(target)) return;
    const actionType = isDateValue(target.value) ? 'datetime' : 'fill';
    const details = {
      type: actionType,
      label: labelFor(target),
      value: target.value,
      ...targetWithHint(actionType === 'datetime' ? 'datetime' : 'fill', target),
    };
    const active = beginActiveAction(target, 'input', target.value, details.target, true);
    recordWithActionIdx(active.actionIdx, details, active.startedAt);
  },
  true,
);

document.addEventListener(
  'blur',
  (event) => {
    const target = event.target;
    if (!isTextInput(target) || activeAction?.targetKey !== targetKey(target)) return;
    activeAction = { ...activeAction, blurAt: Date.now() };
    pushActiveAction();
  },
  true,
);

document.addEventListener(
  'change',
  (event) => {
    if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
    const target = event.target;
    if (target instanceof HTMLSelectElement) {
      emit({
        type: 'select',
        label: semanticFieldLabel(target),
        name: target.name || undefined,
        value: target.value,
        text: target.selectedOptions[0]?.textContent?.trim(),
        enumOptions: capturedEnumOptions([...target.options].map((option) => ({
          label: option.textContent?.trim() ?? option.label,
          value: option.value,
        }))),
        ...targetWithHint('select', target),
      }, target, 'select');
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'radio' && target.checked) {
      emit({
        type: 'radio',
        label: semanticFieldLabel(target),
        name: target.name || undefined,
        value: target.value,
        text: adjacentOptionText(target),
        checked: true,
        ...targetWithHint('check', target),
      }, target, 'check');
      return;
    }
    if (target instanceof HTMLInputElement && target.type === 'checkbox') {
      emit({
        type: 'checkbox',
        label: semanticFieldLabel(target),
        name: target.name || undefined,
        value: target.value,
        text: adjacentOptionText(target),
        checked: target.checked,
        ...targetWithHint('check', target),
      }, target, 'check');
      return;
    }
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    const dateEditor = isDateValue(target.value);
    const action = {
      type: dateEditor ? 'datetime' : 'fill',
      label: labelFor(target),
      value: target.value,
      ...targetWithHint(dateEditor ? 'datetime' : 'fill', target),
    };
    const key = targetKey(target);
    if (activeAction?.kind === 'input' && activeAction.targetKey === key) {
      activeAction = {
        ...activeAction,
        value: target.value,
        touchedAt: Date.now(),
        blurAt: activeAction.blurAt,
      };
      pushActiveAction();
      recordWithActionIdx(activeAction.actionIdx, action, activeAction.startedAt);
    } else {
      emit(action, target, 'input');
    }
  },
  true,
);

const initialStateSeen = new WeakSet<Element>();
function scanInitialFormState(): void {
  const recordInitial = Reflect.get(window, '__DSH_RECORD_INITIAL_STATE__');
  if (typeof recordInitial !== 'function') return;
  for (const element of document.querySelectorAll('select, input[type="radio"]:checked, input[type="checkbox"]:checked')) {
    if (!(element instanceof HTMLSelectElement) && !(element instanceof HTMLInputElement)) continue;
    if (initialStateSeen.has(element)) continue;
    initialStateSeen.add(element);
    const type = element instanceof HTMLSelectElement ? 'select' : element.type as 'radio' | 'checkbox';
    const target = generator(element) as ({ matchCount?: number } & Record<string, unknown>);
    delete target.matchCount;
    recordInitial({
      ts: Date.now(),
      type,
      target,
      label: semanticFieldLabel(element),
      name: element.getAttribute('name') || undefined,
      value: element.value,
      text: element instanceof HTMLSelectElement
        ? element.selectedOptions[0]?.textContent?.trim()
        : adjacentOptionText(element),
      checked: element instanceof HTMLInputElement ? element.checked : undefined,
    });
  }
}
Reflect.set(window, '__DSH_INITIAL_FORM_STATE__', scanInitialFormState);
new MutationObserver(scanInitialFormState).observe(document.documentElement, { childList: true, subtree: true });
queueMicrotask(scanInitialFormState);

function isDateValue(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/.test(value);
}

let initialNavigationEmitted = false;
const emitInitialNavigation = (): void => {
  if (initialNavigationEmitted) return;
  if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
  if (typeof Reflect.get(window, '__DSH_RECORD__') !== 'function') return;
  initialNavigationEmitted = true;
  emit({ type: 'navigate', url: location.href });
};
const scheduleInitialNavigation = (): void => { setTimeout(emitInitialNavigation, 0); };
window.addEventListener('DOMContentLoaded', scheduleInitialNavigation);
window.addEventListener('load', scheduleInitialNavigation);
queueMicrotask(emitInitialNavigation);
setTimeout(emitInitialNavigation, 0);
