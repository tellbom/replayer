import {
  EnumMappingError,
  ExecutableValueTraversalError,
  InvalidParameterTypeError,
  MissingParameterError,
  SchemaViolationError,
  UnknownParameterError,
  UnresolvedValueError,
} from './errors.js';
import { createSanitizer } from './sanitize.js';
import type { ParamDefinition } from './schema.js';

const UNRESOLVED = 'TODO_UNRESOLVED';
const EXECUTABLE_VALUE_MAX_DEPTH = 256;

/** Scan one executable value recursively. Both load-time and runtime gates use this implementation. */
export function assertNoUnresolvedValue(value: unknown, location: string): void {
  const path = unresolvedPath(value, location);
  if (path) throw new UnresolvedValueError(`${path} 含 ${UNRESOLVED}，已在产生副作用前中止。请人工修正该值。`);
}

/** Scan only values that can affect execution; diagnostic metadata is deliberately excluded. */
export function assertNoUnresolvedExecutableValues(value: unknown): void {
  if (!isRecord(value)) return;
  const params = Array.isArray(value.params) ? value.params : [];
  params.forEach((param, index) => {
    if (!isRecord(param)) return;
    for (const key of ['default', 'values', 'enumMap'] as const) {
      if (key in param) assertNoUnresolvedValue(param[key], `params[${index}].${key}`);
    }
  });
  const preflight = Array.isArray(value.preflight) ? value.preflight : [];
  preflight.forEach((item, index) => scanRequestOwner(item, `preflight[${index}]`));
  const steps = Array.isArray(value.steps) ? value.steps : [];
  steps.forEach((step, index) => scanStep(step, `steps[${index}]`));
  scanPostcondition(value.postcondition, 'postcondition');
}

export function validateExecutionParams(
  definitions: readonly ParamDefinition[],
  values: Record<string, unknown>,
): void {
  const declared = new Set(definitions.map((definition) => definition.name));
  const unknown = Object.keys(values).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    throw new UnknownParameterError(
      `传入了技能未声明的参数：${safeList(unknown)}。技能实际声明：${safeList([...declared]) || '无'}。请删除未知参数或重新录制技能。`,
    );
  }
  for (const definition of definitions) {
    const value = values[definition.name];
    if (definition.required && value === undefined) {
      throw new MissingParameterError(`缺少必填参数「${safe(definition.name)}」。请提供该参数后重试。`);
    }
    if (value === undefined || definition.type !== 'enum') continue;
    const available = Object.keys(definition.enumMap ?? {});
    const labels = available.length > 0
      ? available
      : (definition.values ?? []).map((item) => item.label);
    const supplied = Array.isArray(value) ? value : [value];
    const invalid = supplied.find((item) => !labels.includes(String(item)));
    if (invalid !== undefined) {
      throw new EnumMappingError(
        `参数「${safe(definition.name)}」的值「${safe(invalid)}」无法映射为提交值。` +
        `该参数当前可用的值：${safeList(labels) || '无'}。` +
        '该技能录制时可能只采集了部分值；若需要其他值请重新录制。',
      );
    }
  }
  for (const definition of definitions) {
    const value = values[definition.name];
    if (value === undefined) continue;
    if (definition.type === 'number' && typeof value !== 'number') {
      throw new InvalidParameterTypeError(
        `参数「${safe(definition.name)}」必须是 number，当前类型为 ${safe(typeof value)}。`,
      );
    }
    if (definition.type === 'boolean' && typeof value !== 'boolean') {
      throw new InvalidParameterTypeError(
        `参数「${safe(definition.name)}」必须是 boolean，当前类型为 ${safe(Array.isArray(value) ? 'array' : typeof value)}。`,
      );
    }
  }
}

export function requestUsesMultipart(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.headers)) return false;
  return Object.entries(value.headers).some(
    ([name, header]) => /^content-type$/i.test(name)
      && typeof header === 'string'
      && /^multipart\/form-data(?:;|$)/i.test(header.trim()),
  );
}

export type MultipartCarrier = 'none' | 'text' | 'unsupported';

/** Classify only browser-reconstructable multipart bodies; file/binary carriers remain fail-closed. */
export function classifyMultipartCarrier(value: unknown): MultipartCarrier {
  if (!requestUsesMultipart(value)) return 'none';
  if (!isRecord(value) || !isPlainObject(value.body) || Object.keys(value.body).length === 0) {
    return 'unsupported';
  }
  return Object.values(value.body).every((field) =>
    isMultipartTextScalar(field)
    || (Array.isArray(field) && field.every(isMultipartTextScalar)))
    ? 'text'
    : 'unsupported';
}

function scanStep(value: unknown, location: string): void {
  if (!isRecord(value)) return;
  scanRequestOwner(value, location);
  scanUi(value.ui, `${location}.ui`);
  scanPostcondition(value.postcondition, `${location}.postcondition`);
}

function scanRequestOwner(value: unknown, location: string): void {
  if (!isRecord(value)) return;
  const request = isRecord(value.request) ? value.request : isRecord(value.network) ? value.network : undefined;
  if (request) {
    for (const key of ['url', 'headers', 'body', 'extract'] as const) {
      if (key in request) assertNoUnresolvedValue(request[key], `${location}.${value.network ? 'network' : 'request'}.${key}`);
    }
  }
  if ('extract' in value) assertNoUnresolvedValue(value.extract, `${location}.extract`);
}

function scanUi(value: unknown, location: string): void {
  if (!isRecord(value)) return;
  for (const key of ['value', 'extract'] as const) {
    if (key in value) assertNoUnresolvedValue(value[key], `${location}.${key}`);
  }
  if (value.preAction) scanUi(value.preAction, `${location}.preAction`);
}

function scanPostcondition(value: unknown, location: string): void {
  if (!isRecord(value)) return;
  scanRequestOwner(value, location);
  if (isRecord(value.match) && 'where' in value.match) {
    assertNoUnresolvedValue(value.match.where, `${location}.match.where`);
  }
}

function unresolvedPath(value: unknown, path: string): string | undefined {
  const pending: Array<{ value: unknown; path: string; depth: number }> = [{ value, path, depth: 0 }];
  const visited = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current.depth > EXECUTABLE_VALUE_MAX_DEPTH) {
      throw new ExecutableValueTraversalError(
        `${current.path} 超过可执行值最大嵌套深度 ${EXECUTABLE_VALUE_MAX_DEPTH}，已在产生副作用前中止。`,
      );
    }
    if (typeof current.value === 'string') {
      if (current.value.includes(UNRESOLVED)) return current.path;
      continue;
    }
    if (current.value === null || ['undefined', 'number', 'boolean'].includes(typeof current.value)) continue;
    if (typeof current.value !== 'object') {
      throw new ExecutableValueTraversalError(`${current.path} 含不可执行的 ${typeof current.value} 值，已中止。`);
    }
    if (visited.has(current.value)) {
      throw new ExecutableValueTraversalError(`${current.path} 含循环或重复对象引用，已中止。`);
    }
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: current.value[index], path: `${current.path}[${index}]`, depth: current.depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(current.value)) {
      throw new ExecutableValueTraversalError(
        `${current.path} 含不支持的对象类型 ${Object.prototype.toString.call(current.value)}，已中止。`,
      );
    }
    const entries = Object.entries(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      pending.push({ value: child, path: `${current.path}.${key}`, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function safe(value: unknown): string {
  return createSanitizer().sanitizeText(String(value));
}

function safeList(values: readonly unknown[]): string {
  return values.map((value) => `「${safe(value)}」`).join('、');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function isMultipartTextScalar(value: unknown): value is string | number | boolean | null {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function unresolvedSchemaError(error: UnresolvedValueError): SchemaViolationError {
  return new SchemaViolationError(error.message, { cause: error });
}
