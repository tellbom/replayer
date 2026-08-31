export {};

type CanonicalKind = 'activate' | 'edit' | 'select' | 'check' | 'key' | 'upload' | 'navigate' | 'unknown';

interface PendingAction {
  actionIdx: number;
  startedAt: number;
  touchedAt: number;
  targetKey: string;
  target: Element;
  lastEventTarget: Element;
  optionTarget?: Element;
  semanticTargetAtStart: Record<string, unknown>;
  before: unknown;
  eventTypes: string[];
  trusted: boolean;
  timer?: number;
}

const SEMANTIC_KEYS = new Set(['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const settleMs = Number(Reflect.get(window, '__DSH_CANONICAL_SETTLE_MS__')) || 800;
let nextActionIdx = 0;
let pending: PendingAction | null = null;
let recentlyClosed: { action: PendingAction; closedAt: number } | null = null;
const capturedElements: Record<number, Element> = {};
Reflect.set(window, '__dsh_clicked__', capturedElements);

function targetKey(element: Element): string {
  const container = element.closest('form, fieldset, [role="group"], [role="radiogroup"]')
    ?? document.body ?? document.documentElement;
  const tag = element.tagName.toLowerCase();
  const name = element.getAttribute('name') ?? '';
  const type = element.getAttribute('type') ?? '';
  const peers = [...container.querySelectorAll(tag)].filter((candidate) =>
    (candidate.getAttribute('name') ?? '') === name && (candidate.getAttribute('type') ?? '') === type);
  return `${tag}|${name}|${type}|${Math.max(0, peers.indexOf(element))}`;
}

function onRawEvent(event: Event): void {
  if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
  if (event instanceof KeyboardEvent && !SEMANTIC_KEYS.has(event.key)) return;
  const rawTarget = event.target instanceof Element ? event.target : document.documentElement;
  const target = interactionTarget(rawTarget);
  const now = Date.now();
  const key = targetKey(target);
  if ((event.type === 'focus' || event.type === 'blur') && (!pending || pending.targetKey !== key)) return;
  if (!pending && canResumePointerSequence(target, key, event.type, now)) {
    pending = recentlyClosed!.action;
    recentlyClosed = null;
    const mutation = Reflect.get(window, '__DSH_MUTATION__') as { begin?: (index: number) => void };
    mutation.begin?.(pending.actionIdx);
  }
  if (!pending || pending.targetKey !== key) {
    void flush();
    const optionTarget = rawTarget.closest('[role="option"]');
    const semanticElement = optionTarget ? optionOwner(optionTarget) ?? target : target;
    pending = {
      actionIdx: nextActionIdx++, startedAt: now, touchedAt: now, targetKey: key, target,
      lastEventTarget: rawTarget,
      ...(optionTarget ? { optionTarget } : {}),
      semanticTargetAtStart: semanticTarget(semanticElement),
      before: observableState(target), eventTypes: [], trusted: true,
    };
    capturedElements[pending.actionIdx] = target;
    const mutation = Reflect.get(window, '__DSH_MUTATION__') as { begin?: (index: number) => void };
    mutation.begin?.(pending.actionIdx);
  }
  pending.lastEventTarget = rawTarget;
  pending.optionTarget = rawTarget.closest('[role="option"]') ?? pending.optionTarget;
  pending.eventTypes.push(event.type);
  pending.trusted = pending.trusted && event.isTrusted;
  pending.touchedAt = now;
  pushActive(pending);
  emit(pending);
  if (pending.timer) clearTimeout(pending.timer);
  pending.timer = window.setTimeout(() => { void flush(); }, settleMs);
}

async function flush(): Promise<void> {
  const action = pending;
  if (!action) return;
  pending = null;
  recentlyClosed = { action, closedAt: Date.now() };
  if (action.timer) clearTimeout(action.timer);
  let domMutations: unknown[] = [];
  try {
    const mutation = Reflect.get(window, '__DSH_MUTATION__') as {
      end?: (index: number, milliseconds?: number) => Promise<unknown[]>;
    };
    const enhanced = mutation as typeof mutation & {
      endWithStates?: (index: number, milliseconds?: number) => Promise<unknown[]>;
    };
    domMutations = enhanced.endWithStates
      ? await enhanced.endWithStates(action.actionIdx, settleMs)
      : await mutation.end?.(action.actionIdx, settleMs) ?? [];
  } catch {
    domMutations = [];
  }
  if (pending === action) return;
  await emit(action, domMutations);
  if (!pending) pushActive(null);
}

async function emit(action: PendingAction, domMutations: unknown[] = []): Promise<void> {
  const evidenceTarget = action.optionTarget ?? action.lastEventTarget;
  const after = observableState(action.target, evidenceTarget);
  const kind = classify(action.eventTypes, action.target, evidenceTarget);
  const enumOptions = captureEnumOptions(action.target, evidenceTarget);
  const record = Reflect.get(window, '__DSH_CANONICAL_RECORD__');
  if (typeof record !== 'function') return;
  await Promise.resolve(record({
    id: `a${action.actionIdx}-${action.startedAt}`,
    actionIdx: action.actionIdx,
    timestamp: action.startedAt,
    kind,
    target: action.semanticTargetAtStart,
    ...(enumOptions ? { enumOptions } : {}),
    before: action.before,
    after: {
      ...(after as Record<string, unknown>),
      ...(domMutations.length > 0 ? {
        affected: domMutations.slice(0, Number(Reflect.get(window, '__DSH_CANONICAL_MAX_AFFECTED__')) || 20)
          .map((effect) => ({
            locator: (effect as { locator: unknown }).locator,
            state: (effect as { after: unknown }).after,
          })),
        affectedTruncated: domMutations.length > (Number(Reflect.get(window, '__DSH_CANONICAL_MAX_AFFECTED__')) || 20),
      } : {}),
    },
    effects: domMutations.length > 0 ? { domMutations } : undefined,
    raw: {
      eventTypes: [...action.eventTypes],
      trusted: action.trusted,
      ...(kind === 'unknown' ? { unclassifiedReason: '未观察到可归类的标准交互序列' } : {}),
    },
    source: 'playwright-probe',
  })).catch(() => undefined);
}

function classify(events: string[], target: Element, rawTarget: Element = target): CanonicalKind {
  const option = rawTarget.closest('[role="option"]');
  if (events.includes('change')) {
    if (target instanceof HTMLInputElement && target.type === 'file') return 'upload';
    if (target instanceof HTMLInputElement && (target.type === 'checkbox' || target.type === 'radio')) return 'check';
    if (target instanceof HTMLSelectElement || option) return 'select';
  }
  if (option && events.includes('click')) return 'select';
  if (events.some((type) => ['beforeinput', 'input', 'compositionstart', 'compositionend'].includes(type))) return 'edit';
  if (events.includes('keydown')) return 'key';
  if (events.some((type) => ['pointerdown', 'pointerup', 'click'].includes(type))) return 'activate';
  if (events.includes('drop') && target instanceof HTMLInputElement && target.type === 'file') return 'upload';
  return 'unknown';
}

function semanticTarget(element: Element): Record<string, unknown> {
  const generated = (Reflect.get(window, '__DSH_PWGEN__') as ((target: Element) => {
    selector: string; confidence: 'HIGH' | 'LOW';
  }) | undefined)?.(element);
  const labels = element instanceof HTMLInputElement || element instanceof HTMLSelectElement
    ? [...(element.labels ?? [])].map((label) => normalized(label.textContent)).filter(Boolean)
    : [];
  const role = element.getAttribute('role') ?? implicitRole(element);
  const accessibleName = element.getAttribute('aria-label')?.trim()
    || labels.join(' ')
    || element.getAttribute('placeholder')?.trim()
    || normalized(element.textContent)
    || undefined;
  const ancestorRoles = [...ancestors(element)].map((item) => item.getAttribute('role')).filter(Boolean) as string[];
  const form = element.closest('form');
  return {
    tag: element.tagName.toLowerCase(),
    ...(role ? { role } : {}),
    ...(accessibleName ? { accessibleName } : {}),
    ...(element.getAttribute('name') ? { name: element.getAttribute('name') } : {}),
    ...(element.getAttribute('type') ? { inputType: element.getAttribute('type') } : {}),
    ...(element.getAttribute('placeholder') ? { placeholder: element.getAttribute('placeholder') } : {}),
    ...(generated ? { locatorEvidence: { generatedSelector: generated.selector, confidence: generated.confidence } } : {}),
    neighborhood: {
      ...(ancestorRoles.length > 0 ? { ancestorRoles } : {}),
      ...(labels.length > 0 ? { labelText: labels.join(' ') } : {}),
      ...(form ? { formScope: form.getAttribute('aria-label') ?? normalized(form.querySelector('legend')?.textContent) } : {}),
    },
  };
}

function observableState(element: Element, rawTarget: Element = element): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  if (element instanceof HTMLSelectElement) {
    self.value = element.multiple ? [...element.selectedOptions].map((option) => option.value) : element.value;
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    self.value = element.value;
  }
  if (element instanceof HTMLInputElement) {
    self.checked = element.checked;
    self.files = element.files ? [...element.files].map(({ name, size, type }) => ({ name, size, type })) : undefined;
  }
  if (element instanceof HTMLOptionElement) self.selected = element.selected;
  if (element instanceof HTMLElement && element.isContentEditable) self.innerHTML = element.innerHTML;
  const selectedOption = rawTarget.closest('[role="option"]');
  if (selectedOption && selectedOption !== element) {
    const optionValue = selectedOption.getAttribute('value') ?? selectedOption.getAttribute('data-value')
      ?? normalized(selectedOption.textContent);
    self.value = optionValue;
    self.textContent = normalized(selectedOption.textContent);
  }
  self.textContent = normalized(element.textContent);
  const aria = Object.fromEntries(
    ['checked', 'selected', 'expanded', 'valuenow', 'valuetext', 'pressed', 'disabled', 'invalid']
      .map((name) => [name, element.getAttribute(`aria-${name}`)])
      .filter((entry): entry is [string, string] => entry[1] !== null),
  );
  if (Object.keys(aria).length > 0) self.aria = aria;
  if ('disabled' in element) self.disabled = Boolean(Reflect.get(element, 'disabled'));
  if ('readOnly' in element) self.readonly = Boolean(Reflect.get(element, 'readOnly'));
  return { self, page: { url: location.href, focusedLocator: focusedLocator() } };
}

function focusedLocator(): unknown {
  const focused = document.activeElement;
  if (!(focused instanceof Element)) return undefined;
  const generated = Reflect.get(window, '__DSH_PWGEN__');
  if (typeof generated !== 'function') return undefined;
  const result = generated(focused) as { selector: string; confidence: 'HIGH' | 'LOW' };
  return { strategy: 'playwright', selector: result.selector, confidence: result.confidence };
}

function pushActive(action: PendingAction | null): void {
  const snapshot = action ? {
    actionIdx: action.actionIdx, targetKey: action.targetKey, target: action.semanticTargetAtStart,
    kind: activeKind(action.eventTypes), value: liveValue(action.target), startedAt: action.startedAt,
    touchedAt: action.touchedAt, blurAt: action.eventTypes.at(-1) === 'blur' ? Date.now() : null,
  } : null;
  Reflect.set(window, '__DSH_ACTIVE_ACTION__', snapshot);
  const update = Reflect.get(window, '__DSH_ACTIVE_ACTION_UPDATE__');
  if (typeof update === 'function') void Promise.resolve(update(snapshot)).catch(() => undefined);
}

function canResumePointerSequence(
  target: Element,
  key: string,
  eventType: string,
  now: number,
): boolean {
  if (!recentlyClosed) return false;
  const mergeGraceMs = Number(Reflect.get(window, '__DSH_CANONICAL_POINTER_MERGE_GRACE_MS__')) || 250;
  const { action, closedAt } = recentlyClosed;
  if (now - closedAt > mergeGraceMs || action.target !== target || action.targetKey !== key) return false;
  if (eventType === 'pointerup') {
    return action.eventTypes.includes('pointerdown') && !action.eventTypes.includes('pointerup');
  }
  if (eventType === 'click') {
    return action.eventTypes.includes('pointerdown') && !action.eventTypes.includes('click');
  }
  return false;
}

function activeKind(events: string[]): 'input' | 'click' | 'select' | 'check' {
  const kind = classify(
    events,
    pending?.target ?? document.documentElement,
    pending?.optionTarget ?? pending?.lastEventTarget ?? document.documentElement,
  );
  if (kind === 'edit') return 'input';
  if (kind === 'select') return 'select';
  if (kind === 'check') return 'check';
  return 'click';
}

function interactionTarget(target: Element): Element {
  const option = target.closest('[role="option"]');
  return option ?? target;
}

function optionOwner(option: Element): Element | null {
  const listboxId = option.closest('[role="listbox"]')?.id;
  if (listboxId) {
    const owner = [...document.querySelectorAll('[aria-controls]')].find((candidate) =>
      candidate.getAttribute('aria-controls')?.split(/\s+/).includes(listboxId));
    if (owner) return owner;
  }
  const focused = document.activeElement;
  return focused instanceof Element && focused.getAttribute('role') === 'combobox' ? focused : null;
}

function liveValue(element: Element): string | null {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value;
  }
  return null;
}

function implicitRole(element: Element): string | undefined {
  if (element instanceof HTMLButtonElement) return 'button';
  if (element instanceof HTMLAnchorElement && element.href) return 'link';
  if (element instanceof HTMLSelectElement) return element.multiple ? 'listbox' : 'combobox';
  if (element instanceof HTMLTextAreaElement) return 'textbox';
  if (element instanceof HTMLInputElement) {
    if (element.type === 'checkbox') return 'checkbox';
    if (element.type === 'radio') return 'radio';
    return 'textbox';
  }
  return undefined;
}

function* ancestors(element: Element): Generator<Element> {
  let current = element.parentElement;
  while (current) { yield current; current = current.parentElement; }
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function captureEnumOptions(
  target: Element,
  rawTarget: Element,
): {
  items: Array<{ label: string; value: string }>;
  complete: boolean;
  incompleteReason?: 'truncated' | 'dynamic-loading' | 'partial-dom';
} | undefined {
  let elements: Element[] = [];
  let incompleteReason: 'dynamic-loading' | 'partial-dom' | undefined;
  if (target instanceof HTMLSelectElement) {
    elements = [...target.options];
  } else {
    const listbox = rawTarget.closest('[role="listbox"]');
    if (!listbox) return undefined;
    elements = [...listbox.querySelectorAll('[role="option"]')];
    if (elements.length === 0) return undefined;
    const declaredSize = Math.max(...elements.map((item) => Number(item.getAttribute('aria-setsize')) || 0));
    incompleteReason = listbox.getAttribute('aria-busy') === 'true'
      ? 'dynamic-loading'
      : declaredSize > elements.length ? 'partial-dom' : undefined;
  }
  const items = elements.map((item) => ({
    label: normalized(item.getAttribute('aria-label') ?? item.textContent),
    value: item instanceof HTMLOptionElement
      ? item.value
      : item.getAttribute('value') ?? normalized(item.textContent),
  }));
  const maxOptions = Number(Reflect.get(window, '__DSH_ENUM_MAX_OPTIONS__'));
  if (!Number.isInteger(maxOptions) || maxOptions <= 0) {
    return { items: [], complete: false, incompleteReason: 'partial-dom' };
  }
  if (items.length > maxOptions) {
    return { items: items.slice(0, maxOptions), complete: false, incompleteReason: 'truncated' };
  }
  return incompleteReason
    ? { items, complete: false, incompleteReason }
    : { items, complete: true };
}

const initialStateSeen = new WeakSet<Element>();
function scanInitialFormState(): void {
  const recordInitial = Reflect.get(window, '__DSH_RECORD_INITIAL_STATE__');
  if (typeof recordInitial !== 'function') return;
  for (const element of document.querySelectorAll(
    'select, input[type="radio"]:checked, input[type="checkbox"]:checked',
  )) {
    if (!(element instanceof HTMLSelectElement) && !(element instanceof HTMLInputElement)) continue;
    if (initialStateSeen.has(element)) continue;
    const evidence = semanticTarget(element).locatorEvidence as {
      generatedSelector?: string;
      confidence?: 'HIGH' | 'LOW';
    } | undefined;
    if (!evidence?.generatedSelector) continue;
    initialStateSeen.add(element);
    const target = semanticTarget(element);
    const type = element instanceof HTMLSelectElement
      ? 'select'
      : element.type as 'radio' | 'checkbox';
    void Promise.resolve(recordInitial({
      ts: Date.now(),
      type,
      target: {
        strategy: 'playwright',
        selector: evidence.generatedSelector,
        confidence: evidence.confidence,
      },
      label: target.neighborhood && typeof target.neighborhood === 'object'
        ? (target.neighborhood as { labelText?: string }).labelText
        : target.accessibleName,
      name: element.getAttribute('name') || undefined,
      value: element.value,
      text: element instanceof HTMLSelectElement
        ? element.selectedOptions[0]?.textContent?.trim()
        : target.accessibleName,
      checked: element instanceof HTMLInputElement ? element.checked : undefined,
    })).catch(() => undefined);
  }
}

for (const type of [
  'pointerdown', 'pointerup', 'click', 'beforeinput', 'input', 'change', 'keydown',
  'compositionstart', 'compositionend', 'focus', 'blur', 'drop',
]) document.addEventListener(type, onRawEvent, true);

Reflect.set(window, '__DSH_INITIAL_FORM_STATE__', scanInitialFormState);
startInitialFormStateObservation();

Reflect.set(window, '__DSH_CANONICAL_FLUSH__', flush);
queueMicrotask(() => {
  if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
  const record = Reflect.get(window, '__DSH_CANONICAL_RECORD__');
  if (typeof record !== 'function') return;
  void Promise.resolve(record({
    id: `a${nextActionIdx}-${Date.now()}`,
    actionIdx: nextActionIdx++, timestamp: Date.now(), kind: 'navigate',
    after: { page: { url: location.href } },
    effects: { navigation: { url: location.href } },
    raw: { eventTypes: ['framenavigated'], trusted: true }, source: 'playwright-probe',
  })).catch(() => undefined);
});

function startInitialFormStateObservation(): void {
  const root = document.documentElement;
  if (!root) {
    document.addEventListener('DOMContentLoaded', startInitialFormStateObservation, { once: true });
    return;
  }
  new MutationObserver(scanInitialFormState).observe(root, { childList: true, subtree: true });
  queueMicrotask(scanInitialFormState);
}
