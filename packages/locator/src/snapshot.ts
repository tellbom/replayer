const SNAPSHOT_MAX_LENGTH = 8_000;
const TEXT_MAX_LENGTH = 60;
const TABLE_ROW_LIMIT = 5;

function snapshot(): string {
  const dialog = [...document.querySelectorAll('.el-dialog')].filter(isVisible).at(-1);
  const lines = dialog ? dialogSnapshot(dialog) : pageSnapshot();
  const output = lines.join('\n');
  return output.length <= SNAPSHOT_MAX_LENGTH
    ? output
    : `${output.slice(0, SNAPSHOT_MAX_LENGTH - 12)}\n… 已截断`;
}

function pageSnapshot(): string[] {
  const heading = [...document.querySelectorAll('h1, h2')].find(isVisible);
  const lines = [`[页面] ${shortText(heading?.textContent) || document.title}`];
  let index = 1;

  for (const item of [...document.querySelectorAll('.el-form-item')].filter(isVisible)) {
    const label = normalized(item.querySelector('.el-form-item__label')?.textContent);
    if (!label) continue;
    const control = describeControl(item);
    if (!control) continue;
    lines.push(`[${index}] ${control.kind.padEnd(8)} "${label}"   值:${control.value}`);
    index += 1;
  }

  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
    (element) => isVisible(element) && !element.closest('.el-dialog'),
  );
  for (const button of buttons) {
    const name = shortText(button.textContent);
    if (!name || lines.some((line) => line.includes(`"${name}"`))) continue;
    lines.push(`[${index}] button   "${name}"`);
    index += 1;
  }

  for (const table of [...document.querySelectorAll('.el-table')].filter(isVisible)) {
    lines.push(...tableSnapshot(table));
  }
  return lines;
}

function dialogSnapshot(dialog: Element): string[] {
  const title = shortText(dialog.querySelector('.el-dialog__title')?.textContent);
  const lines = [`[对话框: ${title}]`];
  let index = 1;
  for (const element of [...dialog.querySelectorAll('input, textarea, button, [role="button"]')].filter(
    isVisible,
  )) {
    const kind = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? 'input'
      : 'button';
    const text =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value || '(空)'
        : shortText(element.textContent);
    if (!text) continue;
    lines.push(`[${index}] ${kind.padEnd(8)} "${text}"`);
    index += 1;
  }
  return lines;
}

function tableSnapshot(table: Element): string[] {
  const headers = [...table.querySelectorAll('thead th')]
    .filter(isVisible)
    .map((cell) => shortText(cell.textContent))
    .filter(Boolean);
  const rows = [...table.querySelectorAll('.el-table__row')].filter(isVisible);
  const lines = [`[表格] ${headers.join(' | ')}`];
  for (const row of rows.slice(0, TABLE_ROW_LIMIT)) {
    const cells = [...row.querySelectorAll('.el-table__cell')]
      .map((cell) => shortText(cell.textContent))
      .filter(Boolean);
    lines.push(`  ${cells.join(' | ')}`);
  }
  if (rows.length > TABLE_ROW_LIMIT) lines.push(`  … 共 ${rows.length} 行`);
  return lines;
}

function describeControl(item: Element): { kind: string; value: string } | null {
  const textarea = item.querySelector('textarea');
  if (textarea instanceof HTMLTextAreaElement) {
    return { kind: 'textarea', value: printableValue(textarea.value) };
  }
  const select = item.querySelector('.el-select');
  if (select) {
    const selected = select.querySelector('.el-select__selected-item:not(.is-hidden)');
    return { kind: 'select', value: printableValue(normalized(selected?.textContent)) };
  }
  const input = item.querySelector('input');
  if (input instanceof HTMLInputElement) {
    return {
      kind: item.querySelector('.el-date-editor') ? 'input' : input.readOnly ? 'text' : 'input',
      value: printableValue(input.value),
    };
  }
  return null;
}

function printableValue(value: string): string {
  return value ? shortText(value) : '(空)';
}

function shortText(value: string | null | undefined): string {
  const text = normalized(value);
  return text.length <= TEXT_MAX_LENGTH ? text : `${text.slice(0, TEXT_MAX_LENGTH - 1)}…`;
}

function normalized(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function isVisible(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  const style = getComputedStyle(element);
  return element.offsetParent !== null && style.visibility !== 'hidden' && style.display !== 'none';
}

Object.assign(window, { __DSH_SNAPSHOT__: snapshot });
