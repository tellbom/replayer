import { DerivedParameterOverrideError, createSanitizer } from '@dsh/core';
import type {
  ExecContext, InternalValueDefinition, LocatorStrategy, ParamDefinition, Step,
} from '@dsh/core';
import type { Locator, Page } from 'playwright';

/** Resolve only Analyzer-planned page-derived carriers before serializing a network request. */
export async function materializePageDerived(
  page: Page,
  step: Step,
  context: ExecContext,
  values: readonly (ParamDefinition | InternalValueDefinition)[],
  suppliedOverrides: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  if (!step.network) return;
  const consumed = templateRoots(step.network);
  for (const param of values) {
    if (param.carrier?.via !== 'page-derived' || !consumed.has(param.name)) continue;
    if (!param.carrier.targetLocator) {
      throw new Error(`parameter ${param.name} page-derived carrier has no target locator`);
    }
    const locator = resolveCarrierLocator(page, param.carrier.targetLocator);
    const observed = await locator.evaluate((element) => {
      const value = 'value' in element ? Reflect.get(element, 'value') as unknown : undefined;
      const checked = 'checked' in element ? Reflect.get(element, 'checked') as unknown : undefined;
      return {
        value,
        checked,
        ariaValueNow: element.getAttribute('aria-valuenow'),
        ariaChecked: element.getAttribute('aria-checked'),
        text: element.textContent,
      };
    });
    const raw = observed.value ?? observed.checked ?? observed.ariaValueNow
      ?? observed.ariaChecked ?? observed.text;
    const materialized = coerceObserved(raw, param);
    context.vars[param.name] = materialized;
    if (Object.prototype.hasOwnProperty.call(suppliedOverrides, param.name)) {
      const sanitizer = createSanitizer();
      throw new DerivedParameterOverrideError(
        `参数 ${param.name} 的值由页面在回放时产生，不接受外部传入。` +
        `当前传入值 ${displayValue(sanitizer.sanitizeObject({ [param.name]: suppliedOverrides[param.name] })[param.name])}，` +
        `页面实际值 ${displayValue(sanitizer.sanitizeObject({ [param.name]: materialized })[param.name])}。`,
      );
    }
  }
}

function templateRoots(value: unknown): Set<string> {
  const roots = new Set<string>();
  for (const match of JSON.stringify(value).matchAll(/\{\{\s*([^.[|\s}]+)/g)) {
    if (match[1]) roots.add(match[1]);
  }
  return roots;
}

function resolveCarrierLocator(page: Page, target: LocatorStrategy): Locator {
  if (target.strategy === 'playwright') return page.locator(target.selector);
  if (target.strategy === 'frame-playwright') {
    return page.frameLocator(target.frame).locator(target.selector);
  }
  if (target.strategy === 'css') return page.locator(target.selector);
  if (target.strategy === 'label') return page.getByLabel(target.label, { exact: true });
  if (target.strategy === 'role') {
    return page.getByRole(target.role as Parameters<Page['getByRole']>[0], {
      name: target.name, exact: true,
    });
  }
  if (target.strategy === 'text') {
    const locator = page.getByText(target.text, { exact: target.exact !== false });
    return target.nth === undefined ? locator : locator.nth(target.nth);
  }
  throw new Error(`page-derived carrier does not support deprecated strategy ${target.strategy}`);
}

function coerceObserved(
  value: unknown,
  param: ParamDefinition | InternalValueDefinition,
): unknown {
  if (param.type === 'number') {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`page-derived parameter ${param.name} is not a number`);
    return number;
  }
  if (param.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new Error(`page-derived parameter ${param.name} is not a boolean`);
  }
  if (param.type === 'json') {
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value) as unknown; } catch {
      throw new Error(`page-derived parameter ${param.name} is not JSON`);
    }
  }
  if (param.type === 'file') throw new Error(`page-derived parameter ${param.name} cannot be a file`);
  return value === null || value === undefined ? '' : String(value);
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}
