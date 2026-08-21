import type { ParamDefinition } from './schema.js';
import type { ExecContext } from './types.js';

const TEMPLATE_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;
const EXACT_TEMPLATE_PATTERN = /^\{\{\s*([^{}]+?)\s*\}\}$/;

export function resolveTemplate<T>(
  input: T,
  context: ExecContext,
  paramDefinitions: readonly ParamDefinition[] = [],
): T {
  return resolveValue(input, context, paramDefinitions) as T;
}

function resolveValue(
  input: unknown,
  context: ExecContext,
  paramDefinitions: readonly ParamDefinition[],
): unknown {
  if (typeof input === 'string') return resolveString(input, context, paramDefinitions);
  if (Array.isArray(input)) {
    return input.map((value) => resolveValue(value, context, paramDefinitions));
  }
  if (isRecord(input)) {
    return Object.fromEntries(
      Object.entries(input).map(([key, value]) => [
        key,
        resolveValue(value, context, paramDefinitions),
      ]),
    );
  }
  return input;
}

function resolveString(
  input: string,
  context: ExecContext,
  paramDefinitions: readonly ParamDefinition[],
): unknown {
  const exactMatch = EXACT_TEMPLATE_PATTERN.exec(input);
  if (exactMatch?.[1]) return resolveExpression(exactMatch[1], context, paramDefinitions);

  return input.replace(TEMPLATE_PATTERN, (_match, expression: string) =>
    String(resolveExpression(expression, context, paramDefinitions)),
  );
}

function resolveExpression(
  expression: string,
  context: ExecContext,
  paramDefinitions: readonly ParamDefinition[],
): unknown {
  const [pathPart, ...filterParts] = expression.split('|').map((part) => part.trim());
  if (!pathPart) throw new Error(`模板表达式为空: {{${expression}}}`);

  let value = resolvePath(pathPart, context);
  for (const filter of filterParts) {
    if (filter === 'enumValue') {
      value = resolveEnumValue(pathPart, value, paramDefinitions);
      continue;
    }
    if (filter.startsWith('date:')) {
      value = formatDate(value, filter.slice('date:'.length));
      continue;
    }
    throw new Error(`未知模板过滤器: ${filter}`);
  }
  return value;
}

function resolvePath(path: string, context: ExecContext): unknown {
  const segments = parsePath(path);
  const root = segments[0];
  if (!root) throw new Error(`模板变量不存在: ${path}`);

  let value: unknown;
  let remaining: string[];
  if (Object.prototype.hasOwnProperty.call(context.params, root)) {
    value = context.params[root];
    remaining = segments.slice(1);
  } else if (Object.prototype.hasOwnProperty.call(context.stepResults, root)) {
    value = context.stepResults[root];
    remaining = segments.slice(1);
  } else if (Object.prototype.hasOwnProperty.call(context.vars, root)) {
    value = context.vars[root];
    remaining = segments.slice(1);
  } else {
    throw new Error(`模板变量不存在: ${path}`);
  }

  for (const segment of remaining) {
    if ((isRecord(value) || Array.isArray(value)) && segment in value) {
      value = value[segment as keyof typeof value];
    } else {
      throw new Error(`模板变量不存在: ${path}`);
    }
  }
  if (value === undefined) throw new Error(`模板变量不存在: ${path}`);
  return value;
}

function parsePath(path: string): string[] {
  const normalized = path.replace(/\[(\d+)\]/g, '.$1');
  if (normalized.includes('[') || normalized.includes(']')) {
    throw new Error(`数组循环索引尚未展开: ${path}`);
  }
  return normalized.split('.').filter(Boolean);
}

function resolveEnumValue(
  path: string,
  currentValue: unknown,
  paramDefinitions: readonly ParamDefinition[],
): string {
  const paramName = parsePath(path)[0];
  const definition = paramDefinitions.find((param) => param.name === paramName);
  if (!definition || definition.type !== 'enum') {
    throw new Error(`枚举参数缺少 label/value 映射: ${paramName ?? path}`);
  }
  const mapped = definition.enumMap?.[String(currentValue)];
  if (mapped !== undefined) return mapped;
  const mapping = definition.values?.find((item) => item.label === String(currentValue));
  if (!mapping) throw new Error(`枚举参数不存在 label: ${String(currentValue)}`);
  return mapping.value;
}

function formatDate(value: unknown, format: string): string {
  const parts = dateParts(value);
  return format
    .replaceAll('YYYY', parts.year)
    .replaceAll('MM', parts.month)
    .replaceAll('DD', parts.day)
    .replaceAll('HH', parts.hour)
    .replaceAll('mm', parts.minute)
    .replaceAll('ss', parts.second);
}

function dateParts(value: unknown): {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
} {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      year: String(value.getFullYear()).padStart(4, '0'),
      month: String(value.getMonth() + 1).padStart(2, '0'),
      day: String(value.getDate()).padStart(2, '0'),
      hour: String(value.getHours()).padStart(2, '0'),
      minute: String(value.getMinutes()).padStart(2, '0'),
      second: String(value.getSeconds()).padStart(2, '0'),
    };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(
    String(value),
  );
  if (!match) throw new Error(`日期值格式无效: ${String(value)}`);
  return {
    year: match[1]!,
    month: match[2]!,
    day: match[3]!,
    hour: match[4] ?? '00',
    minute: match[5] ?? '00',
    second: match[6] ?? '00',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
