type ControlKind =
  | 'input' | 'textarea' | 'select' | 'datepicker' | 'radio' | 'checkbox' | 'button' | 'text';

type LocatorStrategy =
  | { strategy: 'label'; label: string; kind: ControlKind }
  | { strategy: 'text'; text: string; exact?: boolean; nth?: number }
  | { strategy: 'role'; role: string; name: string }
  | { strategy: 'css'; selector: string }
  | Record<string, unknown>;

const TIMEOUTS = { wait: 5_000, option: 3_000, transition: 2_000, afterInput: 100 } as const;

function normalized(value: string | null | undefined): string {
  return (value ?? '').replace(/[：:*＊]/g, '').replace(/\s+/g, ' ').trim();
}

function visible(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
}

function locatorError(message: string): Error {
  const error = new Error(message);
  error.name = 'LocatorNotFoundError';
  return error;
}

function byFormItem(label: string, kind: ControlKind): HTMLElement {
  const expected = normalized(label);
  const direct = [...document.querySelectorAll('label')].find((item) =>
    visible(item) && normalized(item.textContent) === expected)?.control;
  if (direct instanceof HTMLElement && matchesKind(direct, kind)) return direct;

  const labelled = [...document.querySelectorAll('[aria-label], [aria-labelledby]')].find((item) => {
    if (!visible(item) || !matchesKind(item, kind)) return false;
    const aria = item.getAttribute('aria-label');
    if (normalized(aria) === expected) return true;
    const ids = item.getAttribute('aria-labelledby')?.split(/\s+/) ?? [];
    return normalized(ids.map((id) => document.getElementById(id)?.textContent).join(' ')) === expected;
  });
  if (labelled instanceof HTMLElement) return labelled;

  const group = [...document.querySelectorAll('fieldset, [role="group"], [role="radiogroup"]')].find((item) =>
    visible(item)
    && normalized(item.querySelector('legend')?.textContent ?? item.getAttribute('aria-label')) === expected);
  const grouped = group ? [...group.querySelectorAll('*')].find((item) => visible(item) && matchesKind(item, kind)) : undefined;
  if (grouped instanceof HTMLElement) return grouped;

  const textNode = [...document.querySelectorAll('label, legend, [role="heading"], span, div')].find((item) =>
    visible(item) && normalized(item.textContent) === expected);
  const container = textNode?.parentElement;
  const nearby = container ? [...container.querySelectorAll('*')].find((item) => visible(item) && matchesKind(item, kind)) : undefined;
  if (nearby instanceof HTMLElement) return nearby;
  throw locatorError(`找不到带标签的控件: ${label}`);
}

function matchesKind(element: Element, kind: ControlKind): boolean {
  if (kind === 'textarea') return element instanceof HTMLTextAreaElement;
  if (kind === 'select') return element instanceof HTMLSelectElement || element.getAttribute('role') === 'combobox';
  if (kind === 'radio') return element instanceof HTMLInputElement && element.type === 'radio';
  if (kind === 'checkbox') return element instanceof HTMLInputElement && element.type === 'checkbox';
  if (kind === 'button') return element instanceof HTMLButtonElement || element.getAttribute('role') === 'button';
  if (kind === 'datepicker') return element instanceof HTMLInputElement;
  if (kind === 'input') return element instanceof HTMLInputElement && !['radio', 'checkbox'].includes(element.type);
  return true;
}

async function selectOption(label: string, optionText: string): Promise<void> {
  const control = byFormItem(label, 'select');
  if (control instanceof HTMLSelectElement) {
    const option = [...control.options].find((item) => normalized(item.textContent) === normalized(optionText));
    if (!option) throw locatorError(`找不到选项: ${optionText}`);
    control.value = option.value;
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  robustClick(control);
  const option = await waitFor(() => [...document.querySelectorAll('[role="option"]')].find((item) =>
    visible(item) && normalized(item.getAttribute('aria-label') ?? item.textContent) === normalized(optionText)), TIMEOUTS.option);
  if (!(option instanceof HTMLElement)) throw locatorError(`找不到选项: ${optionText}`);
  robustClick(option);
}

async function setDateTime(label: string, value: string): Promise<void> {
  const control = byFormItem(label, 'datepicker');
  const input = control instanceof HTMLInputElement ? control : control.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw locatorError(`找不到日期输入框: ${label}`);
  setInputValue(input, value);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  input.blur();
  await delay(TIMEOUTS.afterInput);
}

async function inDialog<T>(title: string, fn: (dialog: HTMLElement) => T): Promise<T> {
  const dialog = await waitFor(() => [...document.querySelectorAll('[role="dialog"], dialog')].find((item) =>
    visible(item) && normalized(accessibleName(item)).includes(normalized(title))));
  await waitFor(() => transitionFinished(dialog), TIMEOUTS.transition);
  return fn(dialog as HTMLElement);
}

function tableRowButton(rowAnchorText: string, buttonText: string): HTMLElement {
  const row = [...document.querySelectorAll('tr, [role="row"]')].find((item) =>
    visible(item) && normalized(item.textContent).includes(normalized(rowAnchorText)));
  const button = row && [...row.querySelectorAll('button, [role="button"]')].find((item) =>
    visible(item) && normalized(accessibleName(item)) === normalized(buttonText));
  if (!(button instanceof HTMLElement)) throw locatorError(`表格行中找不到按钮: ${buttonText}`);
  return button;
}

async function resolve(strategy: LocatorStrategy): Promise<HTMLElement> {
  const name = String(strategy.strategy);
  const legacy = strategy as Record<string, unknown>;
  if (name === 'label') return byFormItem(String(legacy.label), legacy.kind as ControlKind);
  if (name === ['el', 'form', 'item'].join('-')) {
    return byFormItem(String(legacy.label), legacy.kind as ControlKind);
  }
  if (name === ['el', 'option'].join('-')) {
    const owner = String(legacy.ownerLabel); const text = String(legacy.text);
    await selectOption(owner, text);
    const active = document.activeElement;
    return active instanceof HTMLElement ? active : document.body;
  }
  if (name === ['el', 'dialog', 'scoped'].join('-')) {
    return inDialog(String(legacy.dialogTitle), (dialog) => resolveIn(dialog, legacy.inner as LocatorStrategy));
  }
  if (name === ['el', 'table', 'cell'].join('-')) {
    return tableRowButton(String(legacy.rowAnchorText), String(legacy.buttonText));
  }
  return resolveIn(document, strategy);
}

async function resolveIn(root: ParentNode, strategy: LocatorStrategy): Promise<HTMLElement> {
  if (strategy.strategy === 'css') {
    const found = root.querySelector(String(strategy.selector));
    if (found instanceof HTMLElement && visible(found)) return found;
  }
  if (strategy.strategy === 'role') {
    const found = [...root.querySelectorAll(`[role="${CSS.escape(String(strategy.role))}"]`)].find((item) =>
      visible(item) && normalized(accessibleName(item)) === normalized(String(strategy.name)));
    if (found instanceof HTMLElement) return found;
  }
  if (strategy.strategy === 'text') {
    const found = [...root.querySelectorAll('button, a, label, span, p, h1, h2, h3, td')].filter((item) => {
      if (!visible(item)) return false;
      const actual = normalized(item.textContent); const expected = normalized(String(strategy.text));
      return strategy.exact === false ? actual.includes(expected) : actual === expected;
    })[Number(strategy.nth ?? 0)];
    if (found instanceof HTMLElement) return found;
  }
  throw locatorError(`通用 DOM 定位失败: ${JSON.stringify(strategy)}`);
}

function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  return element.getAttribute('aria-label') ?? labelledBy ?? element.textContent ?? '';
}

function transitionFinished(element: Element): boolean {
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.pointerEvents !== 'none'
    && Number.parseFloat(style.opacity || '1') > 0;
}

function robustClick(element: HTMLElement): void {
  element.click();
}

function setInputValue(element: HTMLElement, value: string): void {
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    throw locatorError('setInputValue 仅支持 input/textarea');
  }
  const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw locatorError('浏览器未提供原生 value setter');
  setter.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

async function waitFor<T>(fn: () => T | null | undefined | false, timeout: number = TIMEOUTS.wait): Promise<T> {
  const started = performance.now();
  while (performance.now() - started <= timeout) {
    const value = fn(); if (value) return value;
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
  }
  throw locatorError(`等待条件超时: ${timeout}ms`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

Object.assign(window, { __DSH_LOCATOR__: {
  byFormItem, selectOption, setDateTime, inDialog, tableRowButton, resolve,
  robustClick, setInputValue, waitFor, version: () => 'generic' as const,
} });
