export {};

type AppearedKind =
  | 'dialog'
  | 'drawer'
  | 'listbox'
  | 'menu'
  | 'datepicker'
  | 'table-row'
  | 'panel'
  | 'unknown';

interface AppearedRoot {
  node: Element;
  descriptor: unknown;
  appearedAfterMs: number;
  kind: AppearedKind;
  portaled: boolean;
}

interface TrackedRoot {
  node: Element;
  appearedAfterMs: number;
}

interface Observation {
  observer: MutationObserver;
  startedAt: number;
  roots: TrackedRoot[];
  baseline: Map<Element, Record<string, unknown>>;
}

const DEFAULT_SETTLE_MS = 800;
const observations = new Map<number, Observation>();
const completedRoots = new Map<number, AppearedRoot[]>();
const completedEffects = new Map<number, Array<{
  locator: unknown; before?: Record<string, unknown>; after?: Record<string, unknown>;
}>>();
let activeActionIdx: number | undefined;

function begin(actionIdx: number): void {
  if (observations.has(actionIdx)) throw new Error(`动作 ${actionIdx} 已开始 DOM 观测`);
  if (activeActionIdx !== undefined) finish(activeActionIdx);

  const observation: Observation = {
    observer: undefined as unknown as MutationObserver,
    startedAt: performance.now(),
    roots: [],
    baseline: captureObservableElements(),
  };
  observation.observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes' && mutation.target instanceof Element) {
        const semantic = semanticRoot(mutation.target);
        if (
          semantic &&
          visible(semantic) &&
          (classifySelf(mutation.target) !== 'unknown' || isPortalContainer(mutation.target))
        ) {
          recordRoot(observation, semantic);
        }
      }
      for (const addedNode of mutation.addedNodes) {
        if (addedNode instanceof Element) {
          recordRoot(observation, semanticRoot(addedNode) ?? addedNode);
        }
      }
    }
  });
  observation.observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['aria-hidden', 'class', 'hidden', 'style'],
    childList: true,
    subtree: true,
  });
  observations.set(actionIdx, observation);
  activeActionIdx = actionIdx;
}

async function end(actionIdx: number, settleMs = DEFAULT_SETTLE_MS): Promise<AppearedRoot[]> {
  const completed = completedRoots.get(actionIdx);
  if (completed) return completed;
  const observation = observations.get(actionIdx);
  if (!observation) throw new Error(`动作 ${actionIdx} 未开始 DOM 观测`);

  await delay(settleMs);
  return completedRoots.get(actionIdx) ?? finish(actionIdx);
}

async function endWithStates(
  actionIdx: number,
  settleMs = DEFAULT_SETTLE_MS,
): Promise<Array<{ locator: unknown; before?: Record<string, unknown>; after?: Record<string, unknown> }>> {
  await end(actionIdx, settleMs);
  return completedEffects.get(actionIdx) ?? [];
}

function finish(actionIdx: number): AppearedRoot[] {
  const observation = observations.get(actionIdx);
  if (!observation) throw new Error(`动作 ${actionIdx} 未开始 DOM 观测`);
  observation.observer.disconnect();
  observations.delete(actionIdx);
  if (activeActionIdx === actionIdx) activeActionIdx = undefined;
  const roots = observation.roots
    .filter(({ node }) => node.isConnected)
    .map(({ node, appearedAfterMs }) => ({
      node,
      descriptor: generateDescriptor(node),
      appearedAfterMs,
      kind: classify(node),
      portaled: isPortaled(node),
    }));
  completedRoots.set(actionIdx, roots);
  const current = captureObservableElements();
  const effects: Array<{ locator: unknown; before?: Record<string, unknown>; after?: Record<string, unknown> }> = [];
  for (const element of new Set([...observation.baseline.keys(), ...current.keys()])) {
    if (!element.isConnected) continue;
    const before = observation.baseline.get(element);
    const after = current.get(element);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    effects.push({ locator: generateDescriptor(element), ...(before ? { before } : {}), ...(after ? { after } : {}) });
  }
  completedEffects.set(actionIdx, effects);
  return roots;
}

function captureObservableElements(): Map<Element, Record<string, unknown>> {
  const output = new Map<Element, Record<string, unknown>>();
  const selector = [
    'input', 'textarea', 'select', 'option', '[contenteditable]',
    '[aria-checked]', '[aria-selected]', '[aria-expanded]', '[aria-valuenow]',
    '[aria-valuetext]', '[aria-pressed]', '[aria-disabled]', '[aria-invalid]',
  ].join(',');
  for (const element of document.querySelectorAll(selector)) output.set(element, observableElementState(element));
  return output;
}

function observableElementState(element: Element): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  if (element instanceof HTMLSelectElement) {
    state.value = element.multiple ? [...element.selectedOptions].map((option) => option.value) : element.value;
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) state.value = element.value;
  if (element instanceof HTMLInputElement) state.checked = element.checked;
  if (element instanceof HTMLOptionElement) state.selected = element.selected;
  if (element instanceof HTMLElement && element.isContentEditable) {
    const maximum = Number(Reflect.get(window, '__DSH_CANONICAL_MAX_INNER_HTML__')) || 8_192;
    state.innerHTML = element.innerHTML.slice(0, maximum);
    if (element.innerHTML.length > maximum) state.innerHTMLTruncated = true;
  }
  const aria = Object.fromEntries(
    ['checked', 'selected', 'expanded', 'valuenow', 'valuetext', 'pressed', 'disabled', 'invalid']
      .map((name) => [name, element.getAttribute(`aria-${name}`)])
      .filter((item): item is [string, string] => item[1] !== null),
  );
  if (Object.keys(aria).length > 0) state.aria = aria;
  if ('disabled' in element) state.disabled = Boolean(Reflect.get(element, 'disabled'));
  if ('readOnly' in element) state.readonly = Boolean(Reflect.get(element, 'readOnly'));
  return state;
}

function deriveScope(
  producerActionIdx: number,
  target: Element,
): { root: Omit<AppearedRoot, 'node'>; target: unknown } | null {
  const containing = (completedRoots.get(producerActionIdx) ?? [])
    .filter(({ node }) => node.contains(target))
    .sort((left, right) => (left.node.contains(right.node) ? 1 : -1))[0];
  if (!containing) return null;

  const generate = Reflect.get(window, '__DSH_PWGEN__');
  if (typeof generate !== 'function') throw new Error('Playwright locator generator 未注入');
  const option = target.closest('[role="option"], option');
  const optionText = option?.textContent?.replace(/\s+/g, ' ').trim();
  const optionMatches = optionText
    ? [...containing.node.querySelectorAll('[role="option"], option')].filter(
        (candidate) => candidate.textContent?.replace(/\s+/g, ' ').trim() === optionText,
      )
    : [];
  const generated = option && optionMatches.length === 1 && optionMatches[0] === option
    ? {
        selector: `internal:role=option[name=${JSON.stringify(optionText)}i]`,
        confidence: 'HIGH' as const,
      }
    : generate(target, containing.node) as {
        selector: string;
        confidence: 'HIGH' | 'LOW';
      };
  return {
    root: {
      descriptor: containing.descriptor,
      appearedAfterMs: containing.appearedAfterMs,
      kind: containing.kind,
      portaled: containing.portaled,
    },
    target: {
      strategy: 'playwright',
      selector: generated.selector,
      confidence: generated.confidence,
    },
  };
}

function recordRoot(observation: Observation, node: Element): void {
  if (observation.roots.some((root) => root.node === node || root.node.contains(node))) return;

  let appearedAfterMs = performance.now() - observation.startedAt;
  observation.roots = observation.roots.filter((root) => {
    if (!node.contains(root.node)) return true;
    appearedAfterMs = Math.min(appearedAfterMs, root.appearedAfterMs);
    return false;
  });
  observation.roots.push({ node, appearedAfterMs });
}

function classify(root: Element): AppearedKind {
  const ownKind = classifySelf(root);
  if (ownKind !== 'unknown') return ownKind;
  if (contains(root, '[role="dialog"], dialog')) return 'dialog';
  if (contains(root, '[role="listbox"]')) return 'listbox';
  if (contains(root, '[role="menu"]')) return 'menu';
  if (contains(root, '[role="row"], tr')) return 'table-row';
  if (contains(root, '[role="region"], fieldset')) return 'panel';
  return 'unknown';
}

function classifySelf(element: Element): AppearedKind {
  if (element.matches('[role="dialog"], dialog')) return 'dialog';
  if (element.matches('[role="listbox"]')) return 'listbox';
  if (element.matches('[role="menu"]')) return 'menu';
  if (element.matches('[role="row"], tr')) return 'table-row';
  if (element.matches('[role="region"], fieldset')) return 'panel';
  return 'unknown';
}

function contains(root: Element, selector: string): boolean {
  return root.matches(selector) || root.querySelector(selector) !== null;
}

function isPortaled(root: Element): boolean {
  if (root.parentElement === document.body || root.parentElement?.parentElement === document.body) return true;
  if (root.matches('[role="listbox"], [role="menu"]')
    && !root.closest('main, form, [role="dialog"], dialog')) return true;
  const portalContainer = root.closest('[data-popper-placement], [role="dialog"], [role="listbox"], [role="menu"]');
  return portalContainer !== null && portalContainer.parentElement === document.body;
}

function semanticAncestor(node: Element): Element | null {
  for (const selector of [
    '[role="dialog"]', 'dialog', '[role="listbox"]', '[role="menu"]',
    '[role="region"]', '[role="row"]', 'tr', 'fieldset',
  ]) {
    const ancestor = node.closest(selector);
    if (ancestor) return ancestor;
  }
  return null;
}

function semanticRoot(node: Element): Element | null {
  const ancestor = semanticAncestor(node);
  if (ancestor) return ancestor;
  return node.querySelector(
    '[role="dialog"], dialog, [role="listbox"], [role="menu"], [role="region"], [role="row"], tr, fieldset',
  );
}

function isPortalContainer(element: Element): boolean {
  return element.matches('[data-popper-placement], [role="dialog"], [role="listbox"], [role="menu"]');
}

function visible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function generateDescriptor(root: Element): unknown {
  const generate = Reflect.get(window, '__DSH_PWGEN__');
  if (typeof generate !== 'function') throw new Error('Playwright locator generator 未注入');
  const result = generate(root) as { selector: string; confidence: 'HIGH' | 'LOW' };
  return { strategy: 'playwright', selector: result.selector, confidence: result.confidence };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

Object.assign(window, {
  __DSH_MUTATION__: { begin, end, endWithStates, deriveScope },
});
