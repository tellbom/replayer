import { LocatorNotFoundError, ScopeNotReadyError, resolveTemplate } from '@dsh/core';
import type { ExecContext, LocatorStrategy, ParamDefinition, Step, StepResult } from '@dsh/core';
import type { Locator, Page } from 'playwright';

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
    const requestWait = step.waitAfter?.requestUrlPattern
      ? page.waitForResponse(
          (response) => response.url().includes(step.waitAfter!.requestUrlPattern!),
          { timeout: step.waitAfter.timeoutMs },
        )
      : null;
    const value = await runAction(page, action, context);
    if (requestWait) await requestWait;
    await waitAfterAction(page, step.waitAfter);
    if (step.produces) await registerScope(page, step, context);
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
    if (error instanceof ScopeNotReadyError) throw error;
    throw locatorFailure(step, action.target ?? shortcutTarget(action), error);
  }
}

async function waitAfterAction(page: Page, waitAfter: Step['waitAfter']): Promise<void> {
  if (!waitAfter) return;
  const timeout = waitAfter.timeoutMs;
  if (waitAfter.urlPattern) {
    await page.waitForURL((url) => url.href.includes(waitAfter.urlPattern!), { timeout });
  }
  if (waitAfter.networkIdle) await page.waitForLoadState('networkidle', { timeout });
  if (waitAfter.notEmpty) {
    await page.waitForFunction(
      async (strategy) => {
        try {
          const element = await window.__DSH_LOCATOR__.resolve(strategy);
          const value =
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
              ? element.value
              : element.textContent;
          return Boolean(value?.trim());
        } catch {
          return false;
        }
      },
      waitAfter.notEmpty,
      { timeout },
    );
  }
}

async function runAction(
  page: Page,
  action: UiAction,
  context: ExecContext,
): Promise<Record<string, unknown>> {
  if (action.preAction) await runAction(page, action.preAction, context);

  if (action.action === 'navigate') {
    if (!action.url) throw new Error('navigate action requires url');
    await page.goto(new URL(action.url, page.url()).href);
  } else if (action.action === 'click' && action.target?.strategy === 'playwright') {
    await (await resolvePlaywrightTarget(page, action, context)).click();
  } else if (action.action === 'fill' && action.target?.strategy === 'playwright') {
    if (action.value === undefined) throw new Error('fill requires value');
    await (await resolvePlaywrightTarget(page, action, context)).fill(action.value);
  } else if (action.action === 'click' && action.target?.strategy === 'frame-playwright') {
    await (await resolvePlaywrightTarget(page, action, context)).click();
  } else if (action.action === 'fill' && action.target?.strategy === 'frame-playwright') {
    if (action.value === undefined) throw new Error('fill requires value');
    await (await resolvePlaywrightTarget(page, action, context)).fill(action.value);
  } else if (
    action.action === 'selectOption' &&
    action.target?.strategy === 'playwright' &&
    action.scope
  ) {
    await (await resolvePlaywrightTarget(page, action, context)).click();
  } else if (action.action === 'click' && action.target?.strategy === 'role') {
    // 【P0】role 语义走 Playwright getByRole：implicit ARIA role（<button>/<a>/<input type=submit>
    // 无显式 role 属性也是 button role）——IIFE resolver 只查显式 [role=...] 属性，
    // 对原生控件必然 LocatorNotFound（实测缺陷）。
    await page
      .getByRole(action.target.role as Parameters<Page['getByRole']>[0], {
        name: action.target.name,
        exact: true,
      })
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
      spec.target ?? ({ strategy: 'el-form-item', label: spec.label!, kind: spec.kind! } as const);
    const element = await window.__DSH_LOCATOR__.resolve(target);
    const value =
      element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
        ? element.value
        : (element.textContent ?? '');
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

async function resolvePlaywrightTarget(
  page: Page,
  action: UiAction,
  context: ExecContext,
): Promise<Locator> {
  if (action.target?.strategy !== 'playwright' && action.target?.strategy !== 'frame-playwright') {
    throw new Error('target must use playwright strategy');
  }
  if (action.scope && action.target.strategy === 'frame-playwright') {
    throw new ScopeNotReadyError(`${action.scope}: iframe target 不支持外层 scope`);
  }
  const locator =
    action.target.strategy === 'frame-playwright'
      ? page.frameLocator(action.target.frame).locator(action.target.selector)
      : action.scope
        ? rootLocator(page, context.scopes[action.scope]?.root, action.scope).locator(
            action.target.selector,
          )
        : page.locator(action.target.selector);
  const count = await locator.count();
  if (count !== 1) {
    throw new LocatorNotFoundError(`目标必须唯一命中，实际 ${count}: ${action.target.selector}`);
  }
  return locator;
}

async function registerScope(page: Page, step: Step, context: ExecContext): Promise<void> {
  const produces = step.produces!;
  if (step.waitAfter?.scopeReady && step.waitAfter.scopeReady !== produces.scopeId) {
    throw new ScopeNotReadyError(step.waitAfter.scopeReady);
  }
  const locator = rootLocator(page, produces.root, produces.scopeId);
  try {
    await locator.waitFor({ state: 'visible', timeout: step.waitAfter?.timeoutMs ?? 8_000 });
  } catch (error) {
    throw new ScopeNotReadyError(`${produces.scopeId}: ${String(error)}`, { cause: error });
  }
  const count = await locator.count();
  if (count !== 1) throw new ScopeNotReadyError(`${produces.scopeId} 命中 ${count} 个容器`);
  context.scopes[produces.scopeId] = produces;
  if (step.waitAfter?.settleMs) await page.waitForTimeout(step.waitAfter.settleMs);
}

function rootLocator(page: Page, strategy: LocatorStrategy | undefined, scopeId: string): Locator {
  if (!strategy) throw new ScopeNotReadyError(scopeId);
  if (strategy.strategy === 'playwright') return page.locator(strategy.selector);
  if (strategy.strategy === 'role') {
    return page.getByRole(strategy.role as Parameters<Page['getByRole']>[0], {
      name: strategy.name,
      exact: true,
    });
  }
  if (strategy.strategy === 'text') {
    return page
      .getByText(strategy.text, { exact: strategy.exact !== false })
      .nth(strategy.nth ?? 0);
  }
  if (strategy.strategy === 'css') return page.locator(strategy.selector);
  throw new ScopeNotReadyError(`${scopeId} 不支持 root strategy=${strategy.strategy}`);
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
