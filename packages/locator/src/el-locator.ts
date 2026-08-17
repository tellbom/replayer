type ControlKind =
  | 'input'
  | 'textarea'
  | 'select'
  | 'datepicker'
  | 'radio'
  | 'checkbox'
  | 'button'
  | 'text';

type LocatorStrategy =
  | { strategy: 'el-form-item'; label: string; kind: ControlKind }
  | { strategy: 'el-option'; text: string; ownerLabel: string }
  | { strategy: 'el-dialog-scoped'; dialogTitle: string; inner: LocatorStrategy }
  | { strategy: 'el-table-cell'; rowAnchorText: string; buttonText: string }
  | { strategy: 'text'; text: string; exact?: boolean; nth?: number }
  | { strategy: 'role'; role: string; name: string }
  | { strategy: 'css'; selector: string };

const LOCATOR_TIMEOUTS = {
  waitForDefault: 5_000,
  selectPanel: 3_000,
  dialogAnimation: 200,
  afterSelect: 120,
  afterDateTime: 100,
} as const;

function normalizeText(value: string | null | undefined): string {
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

function formItem(root: ParentNode, label: string): HTMLElement {
  const expected = normalizeText(label);
  const item = [...root.querySelectorAll('.el-form-item')].find((candidate) => {
    const itemLabel = candidate.querySelector('.el-form-item__label');
    return normalizeText(itemLabel?.textContent) === expected && visible(candidate);
  });
  if (!(item instanceof HTMLElement)) throw locatorError(`找不到表单项: ${label}`);
  return item;
}

function controlInFormItem(item: HTMLElement, kind: ControlKind): HTMLElement {
  const selectors: Record<ControlKind, string> = {
    input: 'input:not([type="radio"]):not([type="checkbox"])',
    textarea: 'textarea',
    select: '.el-select',
    datepicker: '.el-date-editor, input',
    radio: '.el-radio, input[type="radio"]',
    checkbox: '.el-checkbox, input[type="checkbox"]',
    button: 'button, [role="button"]',
    text: '.el-form-item__content',
  };
  const control = [...item.querySelectorAll(selectors[kind])].find(visible);
  if (!(control instanceof HTMLElement)) {
    throw locatorError(`表单项 ${normalizeText(item.textContent)} 中找不到 ${kind} 控件`);
  }
  return control;
}

function byFormItem(label: string, kind: ControlKind): HTMLElement {
  return controlInFormItem(formItem(document, label), kind);
}

async function selectOption(label: string, optionText: string): Promise<void> {
  const select = byFormItem(label, 'select');
  const clickTarget = select.querySelector('.el-select__wrapper');
  robustClick(clickTarget instanceof HTMLElement ? clickTarget : select);
  const expected = normalizeText(optionText);
  const option = await waitFor(() => {
    const candidates = [...document.querySelectorAll('.el-select-dropdown')].filter(visible);
    const dropdown = candidates.at(-1);
    return dropdown
      ? [...dropdown.querySelectorAll('.el-select-dropdown__item')].find(
          (candidate) => normalizeText(candidate.textContent) === expected && visible(candidate),
        )
      : undefined;
  }, LOCATOR_TIMEOUTS.selectPanel);
  if (!(option instanceof HTMLElement)) throw locatorError(`找不到选项: ${optionText}`);
  robustClick(option);
  await delay(LOCATOR_TIMEOUTS.afterSelect);
}

async function setDateTime(label: string, value: string): Promise<void> {
  const control = byFormItem(label, 'datepicker');
  const input = control instanceof HTMLInputElement ? control : control.querySelector('input');
  if (!(input instanceof HTMLInputElement)) throw locatorError(`找不到日期输入框: ${label}`);
  setInputValue(input, value);
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  document.body.click();
  await delay(LOCATOR_TIMEOUTS.afterDateTime);
}

async function inDialog<T>(title: string, fn: (dialog: HTMLElement) => T): Promise<T> {
  const expected = normalizeText(title);
  const dialog = await waitFor(() => {
    const dialogs = [...document.querySelectorAll('.el-dialog')].filter(visible);
    return dialogs.find(
      (candidate) =>
        normalizeText(candidate.querySelector('.el-dialog__title')?.textContent) === expected,
    );
  });
  await waitFor(() => getComputedStyle(dialog).opacity === '1');
  await delay(LOCATOR_TIMEOUTS.dialogAnimation);
  return fn(dialog);
}

function tableRowButton(rowAnchorText: string, buttonText: string): HTMLElement {
  const rowText = normalizeText(rowAnchorText);
  const row = [...document.querySelectorAll('.el-table__row')].find(
    (candidate) => visible(candidate) && normalizeText(candidate.textContent).includes(rowText),
  );
  if (!(row instanceof HTMLElement)) throw locatorError(`找不到表格行: ${rowAnchorText}`);
  const expectedButton = normalizeText(buttonText);
  const button = [...row.querySelectorAll('button, [role="button"]')].find(
    (candidate) => visible(candidate) && normalizeText(candidate.textContent) === expectedButton,
  );
  if (!(button instanceof HTMLElement)) throw locatorError(`表格行中找不到按钮: ${buttonText}`);
  return button;
}

async function resolve(strategy: LocatorStrategy): Promise<HTMLElement> {
  return resolveIn(document, strategy);
}

async function resolveIn(root: ParentNode, strategy: LocatorStrategy): Promise<HTMLElement> {
  switch (strategy.strategy) {
    case 'el-form-item':
      return controlInFormItem(formItem(root, strategy.label), strategy.kind);
    case 'el-option': {
      const select = controlInFormItem(formItem(root, strategy.ownerLabel), 'select');
      const clickTarget = select.querySelector('.el-select__wrapper');
      robustClick(clickTarget instanceof HTMLElement ? clickTarget : select);
      const option = await waitFor(() => {
        const dropdown = [...document.querySelectorAll('.el-select-dropdown')].filter(visible).at(-1);
        return dropdown
          ? [...dropdown.querySelectorAll('.el-select-dropdown__item')].find(
              (candidate) => normalizeText(candidate.textContent) === normalizeText(strategy.text),
            )
          : undefined;
      });
      if (!(option instanceof HTMLElement)) throw locatorError(`找不到选项: ${strategy.text}`);
      return option;
    }
    case 'el-dialog-scoped':
      return inDialog(strategy.dialogTitle, (dialog) => resolveIn(dialog, strategy.inner));
    case 'el-table-cell':
      return tableRowButton(strategy.rowAnchorText, strategy.buttonText);
    case 'text': {
      const matches = [...root.querySelectorAll('button, a, label, span, p, h1, h2, h3, td')].filter(
        (candidate) => {
          if (!visible(candidate)) return false;
          const actual = normalizeText(candidate.textContent);
          const expected = normalizeText(strategy.text);
          return strategy.exact === false ? actual.includes(expected) : actual === expected;
        },
      );
      const element = matches[strategy.nth ?? 0];
      if (!(element instanceof HTMLElement)) throw locatorError(`找不到文本: ${strategy.text}`);
      return element;
    }
    case 'role': {
      const matches = [...root.querySelectorAll(`[role="${CSS.escape(strategy.role)}"]`)].filter(
        (candidate) => visible(candidate) && normalizeText(candidate.textContent) === normalizeText(strategy.name),
      );
      const element = matches[0];
      if (!(element instanceof HTMLElement)) {
        throw locatorError(`找不到角色元素: ${strategy.role}/${strategy.name}`);
      }
      return element;
    }
    case 'css': {
      const element = root.querySelector(strategy.selector);
      if (!(element instanceof HTMLElement) || !visible(element)) {
        throw locatorError(`CSS 定位失败: ${strategy.selector}`);
      }
      return element;
    }
  }
}

function robustClick(element: HTMLElement): void {
  const common = { bubbles: true, cancelable: true, composed: true, view: window };
  element.dispatchEvent(new PointerEvent('pointerdown', common));
  element.dispatchEvent(new MouseEvent('mousedown', common));
  element.dispatchEvent(new PointerEvent('pointerup', common));
  element.dispatchEvent(new MouseEvent('mouseup', common));
  element.dispatchEvent(new MouseEvent('click', common));
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

async function waitFor<T>(
  fn: () => T | null | undefined | false,
  timeout: number = LOCATOR_TIMEOUTS.waitForDefault,
): Promise<T> {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= timeout) {
    const value = fn();
    if (value) return value;
    await new Promise<void>((resolveFrame) => requestAnimationFrame(() => resolveFrame()));
  }
  throw locatorError(`等待条件超时: ${timeout}ms`);
}

function version(): 'element-plus' | 'element-ui' {
  const item = document.querySelector('.el-form-item');
  if (
    item &&
    (getComputedStyle(item).getPropertyValue('--el-form-label-font-size') ||
      document.querySelector('.el-overlay, .el-popper.is-pure'))
  ) {
    return 'element-plus';
  }
  return 'element-ui';
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

Object.assign(window, {
  __DSH_LOCATOR__: {
    byFormItem,
    selectOption,
    setDateTime,
    inDialog,
    tableRowButton,
    resolve,
    robustClick,
    setInputValue,
    waitFor,
    version,
  },
});
