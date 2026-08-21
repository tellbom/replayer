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
}

const DEFAULT_SETTLE_MS = 800;
const observations = new Map<number, Observation>();

function begin(actionIdx: number): void {
  if (observations.has(actionIdx)) throw new Error(`动作 ${actionIdx} 已开始 DOM 观测`);

  const observation: Observation = {
    observer: undefined as unknown as MutationObserver,
    startedAt: performance.now(),
    roots: [],
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
}

async function end(actionIdx: number, settleMs = DEFAULT_SETTLE_MS): Promise<AppearedRoot[]> {
  const observation = observations.get(actionIdx);
  if (!observation) throw new Error(`动作 ${actionIdx} 未开始 DOM 观测`);

  await delay(settleMs);
  observation.observer.disconnect();
  observations.delete(actionIdx);

  return observation.roots
    .filter(({ node }) => node.isConnected)
    .map(({ node, appearedAfterMs }) => ({
      node,
      descriptor: generateDescriptor(node),
      appearedAfterMs,
      kind: classify(node),
      portaled: isPortaled(node),
    }));
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
  if (contains(root, '.el-drawer')) return 'drawer';
  if (contains(root, '[role="dialog"], .el-dialog')) return 'dialog';
  if (contains(root, '[role="listbox"], .el-select-dropdown')) return 'listbox';
  if (contains(root, '.el-picker-panel')) return 'datepicker';
  if (contains(root, '[role="menu"], .el-menu--popup')) return 'menu';
  if (contains(root, '.el-table__row')) return 'table-row';
  if (contains(root, '[role="region"], .el-form-item, .el-collapse-item')) return 'panel';
  return 'unknown';
}

function classifySelf(element: Element): AppearedKind {
  if (element.matches('.el-drawer')) return 'drawer';
  if (element.matches('[role="dialog"], .el-dialog')) return 'dialog';
  if (element.matches('[role="listbox"], .el-select-dropdown')) return 'listbox';
  if (element.matches('.el-picker-panel')) return 'datepicker';
  if (element.matches('[role="menu"], .el-menu--popup')) return 'menu';
  if (element.matches('.el-table__row')) return 'table-row';
  if (element.matches('[role="region"], .el-form-item, .el-collapse-item')) return 'panel';
  return 'unknown';
}

function contains(root: Element, selector: string): boolean {
  return root.matches(selector) || root.querySelector(selector) !== null;
}

function isPortaled(root: Element): boolean {
  if (root.parentElement === document.body || root.parentElement?.parentElement === document.body) return true;
  const portalContainer = root.closest('.el-overlay, .el-popper, [data-popper-placement]');
  return portalContainer !== null && !portalContainer.closest('#app');
}

function semanticAncestor(node: Element): Element | null {
  for (const selector of [
    '.el-drawer',
    '.el-dialog',
    '.el-select-dropdown',
    '.el-picker-panel',
    '.el-menu--popup',
    '.el-table__row',
    '.el-form-item',
    '.el-collapse-item',
    '[role="dialog"]',
    '[role="listbox"]',
    '[role="menu"]',
    '[role="region"]',
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
    '.el-drawer, .el-dialog, .el-select-dropdown, .el-picker-panel, .el-menu--popup, ' +
      '.el-table__row, .el-form-item, .el-collapse-item, [role="dialog"], [role="listbox"], ' +
      '[role="menu"], [role="region"]',
  );
}

function isPortalContainer(element: Element): boolean {
  return element.matches('.el-overlay, .el-popper, [data-popper-placement]');
}

function visible(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function generateDescriptor(root: Element): unknown {
  if (Reflect.get(window, '__DSH_LOCATOR_ENGINE__') === 'playwright') {
    const generate = Reflect.get(window, '__DSH_PWGEN__');
    if (typeof generate !== 'function') throw new Error('Playwright locator generator 未注入');
    const result = generate(root) as { selector: string; confidence: 'HIGH' | 'LOW' };
    return { strategy: 'playwright', selector: result.selector, confidence: result.confidence };
  }

  const generate = Reflect.get(window, '__DSH_GEN__');
  if (typeof generate !== 'function') throw new Error('Legacy locator generator 未注入');
  return generate(root);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

Object.assign(window, {
  __DSH_MUTATION__: { begin, end },
});
