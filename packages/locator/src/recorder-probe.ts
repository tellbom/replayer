let openSelectLabel: string | null = null;

function emit(action: Record<string, unknown>): void {
  if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
  const record = Reflect.get(window, '__DSH_RECORD__');
  if (typeof record === 'function') record({ ts: Date.now(), ...action });
}

function generator(element: Element): unknown {
  // 【T-63b】feature flag（由 recorder 按 DSH_LOCATOR_ENV 注入）：
  // playwright 引擎返回 { selector, unique, matchCount, confidence, source }，
  // legacy 引擎保持原有 LocatorStrategy 产物。
  if (Reflect.get(window, '__DSH_LOCATOR_ENGINE__') === 'playwright') {
    const pwgen = Reflect.get(window, '__DSH_PWGEN__');
    if (typeof pwgen === 'function') {
      const generated = pwgen(element) as {
        selector: string;
        unique: boolean;
        matchCount: number;
        confidence: string;
      };
      // POC：target 直接承载 playwright selector 文本；confidence 随行
      return {
        strategy: 'css',
        selector: generated.selector,
        _pwConfidence: generated.confidence,
        _pwMatchCount: generated.matchCount,
      };
    }
  }
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
