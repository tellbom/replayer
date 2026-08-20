import { LocatorNotFoundError, resolveTemplate } from '@dsh/core';
import type {
  ExecContext,
  LocatorStrategy,
  ParamDefinition,
  Step,
  StepResult,
} from '@dsh/core';
import type { Page } from 'playwright';

type UiAction = NonNullable<Step['ui']>;

/** Execute one UI step through the injected semantic locator runtime. */
export async function executeUiStep(
  page: Page,
  step: Step,
  context: ExecContext,
  params: readonly ParamDefinition[],
): Promise<StepResult> {
  const startedAt = Date.now();
  if (!step.ui) throw locatorFailure(step, undefined, new Error('step has no ui action'));

  let action: UiAction;
  try {
    action = resolveTemplate(step.ui, context, params);
  } catch (error) {
    throw locatorFailure(step, step.ui.target, error);
  }

  try {
    const value = await runAction(page, action);
    context.stepResults[step.id] = value;
    return {
      stepId: step.id,
      ok: true,
      outcome: 'confirmed_success',
      channelUsed: 'ui',
      durationMs: Date.now() - startedAt,
      raw: action.action === 'readValue' ? { text: JSON.stringify(value) } : undefined,
    };
  } catch (error) {
    throw locatorFailure(step, action.target ?? shortcutTarget(action), error);
  }
}

async function runAction(page: Page, action: UiAction): Promise<Record<string, unknown>> {
  if (action.preAction) await runAction(page, action.preAction);

  if (action.action === 'navigate') {
    if (!action.url) throw new Error('navigate action requires url');
    await page.goto(new URL(action.url, page.url()).href);
  } else if (action.action === 'click' && action.target?.strategy === 'role') {
    // 【P0】role 语义走 Playwright getByRole：implicit ARIA role（<button>/<a>/<input type=submit>
    // 无显式 role 属性也是 button role）——IIFE resolver 只查显式 [role=...] 属性，
    // 对原生控件必然 LocatorNotFound（实测缺陷）。
    await page
      .getByRole(action.target.role as Parameters<Page['getByRole']>[0], { name: action.target.name, exact: true })
      .first()
      .click();
  } else if (action.action === 'click' && action.target?.strategy === 'text') {
    await page
      .getByText(action.target.text, { exact: action.target.exact !== false })
      .nth(action.target.nth ?? 0)
      .click();
  } else {
    await page.evaluate(async (spec) => {
      const locator = window.__DSH_LOCATOR__;
      const target =
        spec.target ??
        (spec.label && spec.kind
          ? { strategy: 'el-form-item' as const, label: spec.label, kind: spec.kind }
          : undefined);

      if (spec.action === 'selectOption') {
        if (!spec.label || spec.value === undefined) {
          throw new Error('selectOption requires label and value');
        }
        await locator.selectOption(spec.label, spec.value);
      } else if (spec.action === 'setDateTime') {
        if (!spec.label || spec.value === undefined) {
          throw new Error('setDateTime requires label and value');
        }
        await locator.setDateTime(spec.label, spec.value);
      } else if (spec.action === 'waitFor') {
        if (!spec.waitFor?.selector) throw new Error('waitFor requires selector');
        await locator.waitFor(() => {
          const element = document.querySelector(spec.waitFor!.selector!);
          if (!(element instanceof HTMLElement)) return undefined;
          if (!spec.waitFor!.notEmpty) return element;
          const current = element instanceof HTMLInputElement ? element.value : element.textContent;
          return current?.trim() ? element : undefined;
        }, spec.waitFor.timeoutMs);
      } else {
        if (!target) throw new Error(`${spec.action} requires target or label and kind`);
        const element = await locator.resolve(target);
        if (spec.action === 'click') locator.robustClick(element);
        if (spec.action === 'fill') {
          if (spec.value === undefined) throw new Error('fill requires value');
          locator.setInputValue(element, spec.value);
        }
      }
    }, action);
  }

  if (action.action !== 'waitFor' && action.waitFor) {
    await page.evaluate(async (condition) => {
      if (!condition.selector) throw new Error('waitFor requires selector');
      await window.__DSH_LOCATOR__.waitFor(() => {
        const element = document.querySelector(condition.selector!);
        if (!(element instanceof HTMLElement)) return undefined;
        if (!condition.notEmpty) return element;
        const current = element instanceof HTMLInputElement ? element.value : element.textContent;
        return current?.trim() ? element : undefined;
      }, condition.timeoutMs);
    }, action.waitFor);
  }

  if (action.action !== 'readValue') return {};
  if (!action.target && !(action.label && action.kind)) {
    throw new Error('readValue requires target or label and kind');
  }
  return page.evaluate(async (spec) => {
    const target =
      spec.target ??
      ({ strategy: 'el-form-item', label: spec.label!, kind: spec.kind! } as const);
    const element = await window.__DSH_LOCATOR__.resolve(target);
    const value =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : element.textContent ?? '';
    if (!spec.extract || Object.keys(spec.extract).length === 0) return { value };
    return Object.fromEntries(
      Object.entries(spec.extract).map(([name, property]) => {
        if (property === 'value') return [name, value];
        if (property === 'textContent') return [name, element.textContent ?? ''];
        if (property.startsWith('attribute:')) {
          return [name, element.getAttribute(property.slice('attribute:'.length))];
        }
        throw new Error(`unsupported readValue extract: ${property}`);
      }),
    );
  }, action);
}

function shortcutTarget(action: UiAction): LocatorStrategy | undefined {
  return action.label && action.kind
    ? { strategy: 'el-form-item', label: action.label, kind: action.kind }
    : undefined;
}

function locatorFailure(
  step: Step,
  strategy: LocatorStrategy | undefined,
  cause: unknown,
): LocatorNotFoundError {
  return new LocatorNotFoundError(
    `UI step ${step.id} failed; strategy=${JSON.stringify(strategy ?? null)}; ${String(cause)}`,
    { cause },
  );
}
