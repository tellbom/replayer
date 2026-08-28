const SNAPSHOT_MAX_LENGTH = 8_000;
const TEXT_MAX_LENGTH = 60;
const TABLE_ROW_LIMIT = 5;

function snapshot(): string {
  const dialog = [...document.querySelectorAll('[role="dialog"], dialog')].filter(isVisible).at(-1);
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

  for (const element of [...document.querySelectorAll(
    'input, textarea, select, [role="combobox"], [role="checkbox"], [role="radio"]',
  )].filter(isVisible)) {
    const label = accessibleName(element);
    const control = describeControl(element);
    if (!label || !control) continue;
    const rendered = `${control.kind} "${label}"`;
    if (lines.some((line) => line.includes(rendered))) continue;
    lines.push(`[${index}] ${control.kind.padEnd(8)} "${label}"   值:${control.value}`);
    index += 1;
  }

  const buttons = [...document.querySelectorAll('button, [role="button"]')].filter(
    (element) => isVisible(element) && !element.closest('[role="dialog"], dialog'),
  );
  for (const button of buttons) {
    const name = shortText(button.textContent);
    if (!name || lines.some((line) => line.includes(`"${name}"`))) continue;
    lines.push(`[${index}] button   "${name}"`);
    index += 1;
  }

  for (const table of [...document.querySelectorAll('table, [role="table"], [role="grid"]')].filter(isVisible)) {
    lines.push(...tableSnapshot(table));
  }
  return lines;
}

function dialogSnapshot(dialog: Element): string[] {
  const title = shortText(dialog.getAttribute('aria-label') ?? dialog.querySelector('[role="heading"], h1, h2, h3')?.textContent);
  const lines = [`[对话框: ${title}]`];
  let index = 1;
  for (const element of [...dialog.querySelectorAll(
    'input, textarea, select, button, [role="button"], [role="combobox"]',
  )].filter(
    isVisible,
  )) {
    const control = describeControl(element);
    const kind = control?.kind ?? 'button';
    const text = control ? accessibleName(element) : shortText(element.textContent);
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
  const rows = [...table.querySelectorAll('tbody tr, [role="row"]')].filter(isVisible);
  const lines = [`[表格] ${headers.join(' | ')}`];
  for (const row of rows.slice(0, TABLE_ROW_LIMIT)) {
    const cells = [...row.querySelectorAll('td, [role="cell"], [role="gridcell"]')]
      .map((cell) => shortText(cell.textContent))
      .filter(Boolean);
    lines.push(`  ${cells.join(' | ')}`);
  }
  if (rows.length > TABLE_ROW_LIMIT) lines.push(`  … 共 ${rows.length} 行`);
  return lines;
}

function describeControl(item: Element): { kind: string; value: string } | null {
  const textarea = item instanceof HTMLTextAreaElement ? item : item.querySelector('textarea');
  if (textarea instanceof HTMLTextAreaElement) {
    return { kind: 'textarea', value: printableValue(textarea.value) };
  }
  const select = item.matches('select, [role="combobox"]') ? item : item.querySelector('select, [role="combobox"]');
  if (select) {
    const selected = select instanceof HTMLSelectElement
      ? select.selectedOptions[0]?.textContent
      : select.getAttribute('aria-valuetext') ?? select.textContent;
    return { kind: 'select', value: printableValue(normalized(selected)) };
  }
  const input = item instanceof HTMLInputElement ? item : item.querySelector('input');
  if (input instanceof HTMLInputElement) {
    return {
      kind: input.readOnly ? 'text' : 'input',
      value: printableValue(input.value),
    };
  }
  return null;
}

function accessibleName(element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria) return shortText(aria);
  const labelledBy = element.getAttribute('aria-labelledby')?.split(/\s+/)
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  if (labelledBy) return shortText(labelledBy);
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
    || element instanceof HTMLSelectElement) {
    const labels = [...(element.labels ?? [])].map((label) => label.textContent ?? '').join(' ');
    if (labels) return shortText(labels);
  }
  return shortText(element.getAttribute('placeholder'));
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
  return element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

Object.assign(window, { __DSH_SNAPSHOT__: snapshot });
