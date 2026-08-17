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

function generate(element: Element, includeDialog = true): LocatorStrategy {
  const option = element.closest('.el-select-dropdown__item');
  if (option) {
    return {
      strategy: 'el-option',
      text: normalized(option.textContent),
      ownerLabel: optionOwnerLabel(option),
    };
  }

  const dialog = element.closest('.el-dialog');
  if (includeDialog && dialog) {
    return {
      strategy: 'el-dialog-scoped',
      dialogTitle: normalized(dialog.querySelector('.el-dialog__title')?.textContent),
      inner: generate(element, false),
    };
  }

  const row = element.closest('.el-table__row');
  if (row) {
    const button = element.closest('button, [role="button"]') ?? element;
    return {
      strategy: 'el-table-cell',
      rowAnchorText: pickRowAnchor(row),
      buttonText: normalized(button.textContent),
    };
  }

  const item = element.closest('.el-form-item');
  const label = normalized(item?.querySelector('.el-form-item__label')?.textContent);
  if (item && label) {
    return { strategy: 'el-form-item', label, kind: controlKind(element) };
  }

  const roleElement = element.closest('[role], button');
  const roleName = normalized(roleElement?.textContent);
  if (roleElement && roleName) {
    return {
      strategy: 'role',
      role: roleElement.getAttribute('role') ?? 'button',
      name: roleName,
    };
  }

  const text = normalized(element.textContent);
  if (text) return { strategy: 'text', text, exact: true };

  const selector = stableCss(element);
  console.warn(`[DSH] selector-generator 使用 CSS 兜底: ${selector}`);
  return { strategy: 'css', selector };
}

function optionOwnerLabel(option: Element): string {
  const listbox = option.closest('[role="listbox"]');
  const listboxId = listbox?.id;
  const input = listboxId
    ? document.querySelector(`[role="combobox"][aria-controls="${CSS.escape(listboxId)}"]`)
    : null;
  const item = input?.closest('.el-form-item');
  const label = normalized(item?.querySelector('.el-form-item__label')?.textContent);
  if (!label) throw new Error('无法确定 el-option 所属表单项');
  return label;
}

function controlKind(element: Element): ControlKind {
  if (element.closest('.el-select')) return 'select';
  if (element.closest('.el-date-editor')) return 'datepicker';
  if (element.closest('textarea')) return 'textarea';
  const input = element.closest('input');
  if (input?.type === 'radio') return 'radio';
  if (input?.type === 'checkbox') return 'checkbox';
  if (input) return 'input';
  if (element.closest('button, [role="button"]')) return 'button';
  return 'text';
}

function pickRowAnchor(row: Element): string {
  const cells = [...row.querySelectorAll('.el-table__cell')]
    .map((cell) => normalized(cell.textContent))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!cells[0]) throw new Error('表格行没有可用锚点文本');
  return cells[0];
}

function stableCss(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const stableClasses = [...element.classList].filter(
    (className) => !/_\w+_\w{5,}/.test(className) && !/^data-v-/.test(className),
  );
  const classPart = stableClasses.map((className) => `.${CSS.escape(className)}`).join('');
  return `${element.tagName.toLowerCase()}${classPart}`;
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').replace(/[：:*＊]/g, '').replace(/\s+/g, ' ').trim();
}

Object.assign(window, { __DSH_GEN__: generate });
