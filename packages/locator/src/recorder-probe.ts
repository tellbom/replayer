let openSelectLabel: string | null = null;

function emit(action: Record<string, unknown>): void {
  if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
  const record = Reflect.get(window, '__DSH_RECORD__');
  if (typeof record === 'function') record({ ts: Date.now(), ...action });
}

function generator(element: Element): unknown {
  const generate = Reflect.get(window, '__DSH_GEN__');
  return typeof generate === 'function' ? generate(element) : undefined;
}

function labelFor(element: Element): string | undefined {
  return element
    .closest('.el-form-item')
    ?.querySelector('.el-form-item__label')
    ?.textContent?.replace(/[：:*＊]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

document.addEventListener(
  'click',
  (event) => {
    if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
    const target = event.target;
    if (!(target instanceof Element)) return;

    const option = target.closest('.el-select-dropdown__item');
    if (option) {
      const text = option.textContent?.trim() ?? '';
      emit({
        type: 'select',
        label: openSelectLabel,
        value: text,
        text,
        target: generator(option),
      });
      openSelectLabel = null;
      return;
    }

    const select = target.closest('.el-select');
    if (select) {
      openSelectLabel = labelFor(select) ?? null;
      return;
    }

    const interactive = target.closest('button, [role="button"], a');
    if (interactive) {
      emit({ type: 'click', text: interactive.textContent?.trim(), target: generator(interactive) });
    }
  },
  true,
);

document.addEventListener(
  'change',
  (event) => {
    if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
    const target = event.target;
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;
    const dateEditor = target.closest('.el-date-editor');
    emit({
      type: dateEditor ? 'datetime' : 'fill',
      label: labelFor(target),
      value: target.value,
      target: generator(target),
    });
  },
  true,
);

window.addEventListener('DOMContentLoaded', () => {
  emit({ type: 'navigate', url: location.href });
});
