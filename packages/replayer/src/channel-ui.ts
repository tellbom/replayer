import {
  LocatorNotFoundError,
  SemanticDriftError,
  ScopeNotReadyError,
  TIMEOUTS,
  UiCarrierIncompleteError,
  assertNoUnresolvedValue,
  resolveTemplate,
} from '@dsh/core';
import type { ExecContext, LocatorStrategy, ParamDefinition, Step, StepResult } from '@dsh/core';
import type { Locator, Page } from 'playwright';

import { assertLowInspection, inspectLowTarget } from './semantic-guard.js';
import type { LowTargetInspection } from './semantic-guard.js';

type UiAction = NonNullable<Step['ui']>;

export interface UiExecutionHooks {
  onLowTarget?: (inspection: LowTargetInspection) => Promise<boolean>;
}

/** Execute one UI step through the injected semantic locator runtime. */
export async function executeUiStep(
  page: Page,
  step: Step,
  context: ExecContext,
  params: readonly ParamDefinition[],
  hooks: UiExecutionHooks = {},
): Promise<StepResult> {
  const startedAt = Date.now();
  if (!step.ui) throw locatorFailure(step, undefined, new Error('step has no ui action'));

  let action: UiAction;
  try {
    action = resolveTemplate(step.ui, context, params);
    assertNoUnresolvedValue(action, `ui step ${step.id}`);
  } catch (error) {
    if (isNotSentSafetyError(error)) return uiNotSent(step.id, startedAt, error);
    throw locatorFailure(step, step.ui.target, error);
  }

  try {
    if (
      (action.target?.strategy === 'playwright' || action.target?.strategy === 'frame-playwright') &&
      action.target.confidence === 'LOW' &&
      action.recordedHint
    ) {
      const inspection = await inspectLowTarget(
        await resolvePlaywrightTarget(page, action, context),
        action.recordedHint,
      );
      if (hooks.onLowTarget && !(await hooks.onLowTarget(inspection))) {
        return {
          stepId: step.id,
          ok: false,
          outcome: 'not_sent',
          channelUsed: 'ui',
          durationMs: Date.now() - startedAt,
          error: 'User cancelled unverifiable LOW action',
        };
      }
      assertLowInspection(inspection, step.id);
    }
    const requestWait = step.waitAfter?.requestUrlPattern
      ? page.waitForResponse(
          (response) => response.url().includes(step.waitAfter!.requestUrlPattern!),
          { timeout: step.waitAfter.timeoutMs },
        )
      : null;
    const navigationWait = step.expectsRedirect
      ? page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: step.waitAfter?.timeoutMs ?? TIMEOUTS.navigation })
      : null;
    const actionRun = step.riskLevel === 'write' || step.riskLevel === 'critical'
      ? runWriteActionWithCarrierGate(page, step, action, context)
      : runAction(page, action, context);
    const value = navigationWait
      ? (await Promise.all([actionRun, navigationWait]))[0]
      : await actionRun;
    if (requestWait) await requestWait;
    await waitAfterAction(page, step.waitAfter);
    if (step.produces) await registerScope(page, step, context);
    if (action.action !== 'readValue' && action.extract) {
      Object.assign(context.vars, await extractPageVariables(page, action.extract));
    }
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
    if (isNotSentSafetyError(error)) return uiNotSent(step.id, startedAt, error);
    if (error instanceof ScopeNotReadyError || error instanceof SemanticDriftError) throw error;
    throw locatorFailure(step, action.target ?? shortcutTarget(action), error);
  }
}

async function runWriteActionWithCarrierGate(
  page: Page,
  step: Step,
  action: UiAction,
  context: ExecContext,
): Promise<Record<string, unknown>> {
  if (!action.preAction) return runAction(page, action, context);
  await runAction(page, action.preAction, context);
  await assertUiCarrierChain(page, step, action.preAction, context);
  return runAction(page, { ...action, preAction: undefined }, context);
}

async function assertUiCarrierChain(
  page: Page,
  step: Step,
  action: UiAction,
  context: ExecContext,
): Promise<void> {
  if (action.preAction) await assertUiCarrierChain(page, step, action.preAction, context);
  if (!['fill', 'setDateTime', 'selectOption', 'check'].includes(action.action)) return;
  const current = await readUiCarrier(page, action, context);
  const expected = action.action === 'check' ? action.checked !== false : action.value;
  const matches = Array.isArray(current) ? current.includes(String(expected)) : current === expected;
  if (expected === undefined || !matches) {
    throw new UiCarrierIncompleteError(
      `步骤 ${step.id} 的 ${action.action} UI 载体未保持期望值。` +
      '已在提交动作前中止，请检查页面联动或重新录制。',
    );
  }
}

type UiCarrierValue = string | boolean | string[] | undefined;

async function readUiCarrier(page: Page, action: UiAction, context: ExecContext): Promise<UiCarrierValue> {
  if (action.target?.strategy === 'playwright' || action.target?.strategy === 'frame-playwright') {
    return (await resolvePlaywrightTarget(page, action, context)).evaluate((element) => {
      if (element instanceof HTMLInputElement && element.type === 'checkbox') return element.checked;
      const nativeSelect = element instanceof HTMLSelectElement
        ? element
        : element.querySelector('select');
      if (nativeSelect) {
        return [nativeSelect.value, ...Array.from(nativeSelect.selectedOptions, (option) => option.textContent?.trim() ?? '')];
      }
      const ariaControl = element.hasAttribute('aria-controls')
        ? element
        : element.querySelector('[aria-controls]');
      const controlledId = ariaControl?.getAttribute('aria-controls');
      const controlled = controlledId ? document.getElementById(controlledId) : null;
      const selectedOptions = controlled
        ? Array.from(controlled.querySelectorAll('[role="option"][aria-selected="true"]'))
        : [];
      if (selectedOptions.length > 0) {
        return selectedOptions.flatMap((option) => [
          option.getAttribute('value') ?? '',
          option.getAttribute('data-value') ?? '',
          option.textContent?.trim() ?? '',
        ]).filter(Boolean);
      }
      if (element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement) return element.value;
      return element.textContent?.trim();
    });
  }
  return page.evaluate(async (spec) => {
    const inferredKind = spec.kind
      ?? (spec.action === 'selectOption' ? 'select'
        : spec.action === 'setDateTime' ? 'datepicker'
          : undefined);
    const target = spec.target ?? (spec.label && inferredKind
      ? { strategy: 'el-form-item' as const, label: spec.label, kind: inferredKind }
      : undefined);
    if (!target) return undefined;
    const element = await window.__DSH_LOCATOR__.resolve(target);
    if (element instanceof HTMLInputElement && element.type === 'checkbox') return element.checked;
    const nativeSelect = element instanceof HTMLSelectElement
      ? element
      : element.querySelector('select');
    if (nativeSelect) {
      return [nativeSelect.value, ...Array.from(nativeSelect.selectedOptions, (option) => option.textContent?.trim() ?? '')];
    }
    const ariaControl = element.hasAttribute('aria-controls')
      ? element
      : element.querySelector('[aria-controls]');
    const controlledId = ariaControl?.getAttribute('aria-controls');
    const controlled = controlledId ? document.getElementById(controlledId) : null;
    const selectedOptions = controlled
      ? Array.from(controlled.querySelectorAll('[role="option"][aria-selected="true"]'))
      : [];
    if (selectedOptions.length > 0) {
      return selectedOptions.flatMap((option) => [
        option.getAttribute('value') ?? '',
        option.getAttribute('data-value') ?? '',
        option.textContent?.trim() ?? '',
      ]).filter(Boolean);
    }
    if (element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement) return element.value;
    return element.textContent?.trim();
  }, action);
}

function isNotSentSafetyError(error: unknown): error is Error & { outcome: 'not_sent' } {
  return error instanceof Error && 'outcome' in error && error.outcome === 'not_sent';
}

function uiNotSent(stepId: string, startedAt: number, error: Error): StepResult {
  return {
    stepId,
    ok: false,
    outcome: 'not_sent',
    channelUsed: 'ui',
    durationMs: Date.now() - startedAt,
    error: `${error.name}: ${error.message}`,
  };
}

async function extractPageVariables(
  page: Page,
  extracts: Record<string, string>,
): Promise<Record<string, string>> {
  return page.evaluate((spec) => Object.fromEntries(Object.entries(spec).map(([name, selector]) => {
    const matches = document.querySelectorAll(selector);
    if (matches.length !== 1) {
      throw new Error(`page extract must match exactly one element: ${selector} (${matches.length})`);
    }
    const element = matches[0]!;
    const value = element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement
      ? element.value
      : element instanceof HTMLMetaElement
        ? element.content
        : element.textContent ?? '';
    return [name, value];
  })), extracts);
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
  } else if (action.action === 'selectOption' && action.target?.strategy === 'playwright') {
    if (action.value === undefined) throw new Error('selectOption requires value');
    const locator = await resolvePlaywrightTarget(page, action, context);
    const nativeSelect = await locator.evaluate((element) => element instanceof HTMLSelectElement);
    if (nativeSelect) await locator.selectOption(action.value);
    else await locator.click();
  } else if (action.action === 'check' && action.target?.strategy === 'playwright') {
    const locator = await resolvePlaywrightTarget(page, action, context);
    if (action.checked === false) await locator.uncheck();
    else await locator.check();
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
