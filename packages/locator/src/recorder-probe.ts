let openSelectLabel: string | null = null;
let nextActionIdx = 0;
const clickedElements: Record<number, Element> = {};
Reflect.set(window, '__dsh_clicked__', clickedElements);

function emit(action: Record<string, unknown>, clickedElement?: Element): void {
  if (Reflect.get(window, '__DSH_RECORDING__') !== true) return;
  const actionIdx = nextActionIdx;
  nextActionIdx += 1;
  if (clickedElement) clickedElements[actionIdx] = clickedElement;
  const record = Reflect.get(window, '__DSH_RECORD__');
  if (typeof record === 'function') record({ ts: Date.now(), actionIdx, ...action });
}

function generator(element: Element): unknown {
  // 【T-63b/T-67a】feature flag（由 recorder 按 DSH_LOCATOR_ENGINE 注入）：
  // playwright 引擎产出正式 {strategy:'playwright'} 契约（Node 侧
  // Playwright Locator API 解析执行）；legacy 保持原 LocatorStrategy。
  if (Reflect.get(window, '__DSH_LOCATOR_ENGINE__') === 'playwright') {
    const pwgen = Reflect.get(window, '__DSH_PWGEN__');
    if (typeof pwgen === 'function') {
      const generated = pwgen(element) as {
        selector: string;
        unique: boolean;
        matchCount: number;
        confidence: 'HIGH' | 'LOW';
      };
      return {
        strategy: 'playwright',
        selector: generated.selector,
        confidence: generated.confidence,
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
      // 【T-68】每个动作持有独立 oracle，异步消歧不会被后续点击覆盖。
      emit(
        { type: 'click', text: interactive.textContent?.trim(), target: generator(interactive) },
        interactive,
      );
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
