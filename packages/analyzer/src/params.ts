import type { ParamDefinition } from '@dsh/core';
import type { RecordedAction, RecordSession } from '@dsh/core';

const SENSITIVE_PARAM = /token|viewstate|eventvalidation|csrf|session|timestamp/i;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;

export interface ParamCandidate {
  definition: ParamDefinition;
  confidence: number;
  sources: string[];
}

/** 从用户实际输入动作提取参数候选。 */
export function detectParams(
  session: RecordSession,
  secondSession?: RecordSession,
): ParamCandidate[] {
  const candidates = new Map<string, ParamCandidate>();
  session.actions.forEach((action, index) => {
    if (!isInputAction(action) || action.value === undefined) return;
    const name = paramName(action.label, action.type);
    if (SENSITIVE_PARAM.test(name) || SENSITIVE_PARAM.test(action.label ?? '')) return;
    const secondAction = secondSession?.actions[index];
    const changed =
      secondAction?.type === action.type &&
      secondAction.value !== undefined &&
      secondAction.value !== action.value;
    const existing = candidates.get(name);
    const values =
      action.type === 'select'
        ? enumValues(action, secondAction, session, secondSession, index, name)
        : undefined;
    if (existing) {
      existing.sources.push(`action[${index}]`);
      if (changed) existing.confidence = 1;
      if (values && existing.definition.values) {
        existing.definition.values = mergeEnumValues(existing.definition.values, values);
        existing.definition.enumMap = enumMap(existing.definition.values);
      }
      return;
    }
    candidates.set(name, {
      definition: {
        name,
        type: paramType(action),
        values,
        ...(values ? { enumMap: enumMap(values) } : {}),
        required: true,
        prompt: action.label,
      },
      confidence: changed ? 1 : 0.9,
      sources: [`action[${index}]`],
    });
  });
  return [...candidates.values()];
}

function isInputAction(action: RecordedAction): boolean {
  return action.type === 'fill' || action.type === 'select' || action.type === 'datetime';
}

function paramType(action: RecordedAction): ParamDefinition['type'] {
  if (action.type === 'select') return 'enum';
  if (action.type === 'datetime' || DATE_VALUE.test(action.value ?? '')) return 'datetime';
  return 'string';
}

function enumValues(
  action: RecordedAction,
  secondAction: RecordedAction | undefined,
  session: RecordSession,
  secondSession: RecordSession | undefined,
  actionIndex: number,
  name: string,
): Array<{ label: string; value: string }> {
  const values: Array<{ label: string; value: string }> = [];
  if (action.value !== undefined) {
    const responseOptions = enumOptionsFromResponses(session, action.value);
    values.push(...(responseOptions.length > 0
      ? responseOptions
      : [{
          label: action.value,
          value: networkFieldForAction(session, actionIndex, name) ?? action.value,
        }]));
  }
  if (secondAction?.type === 'select' && secondAction.value !== undefined && secondSession) {
    const responseOptions = enumOptionsFromResponses(secondSession, secondAction.value);
    values.push(...(responseOptions.length > 0
      ? responseOptions
      : [{
          label: secondAction.value,
          value: networkFieldForAction(secondSession, actionIndex, name) ?? secondAction.value,
        }]));
  }
  return mergeEnumValues([], values);
}

function enumOptionsFromResponses(
  session: RecordSession,
  selectedLabel: string,
): Array<{ label: string; value: string }> {
  for (const request of session.network) {
    if (!request.responseBody) continue;
    try {
      const body: unknown = JSON.parse(request.responseBody);
      if (!Array.isArray(body)) continue;
      const options = body.flatMap((item) => {
        if (typeof item !== 'object' || item === null) return [];
        const { label, value } = item as { label?: unknown; value?: unknown };
        return typeof label === 'string' && typeof value === 'string' ? [{ label, value }] : [];
      });
      if (options.some((item) => item.label === selectedLabel)) return options;
    } catch {
      continue;
    }
  }
  return [];
}

function enumMap(values: Array<{ label: string; value: string }>): Record<string, string> {
  return Object.fromEntries(values.map((item) => [item.label, item.value]));
}

function mergeEnumValues(
  left: Array<{ label: string; value: string }>,
  right: Array<{ label: string; value: string }>,
): Array<{ label: string; value: string }> {
  return [...new Map([...left, ...right].map((item) => [item.value, item])).values()];
}

function paramName(label: string | undefined, type: RecordedAction['type']): string {
  const names: Record<string, string> = {
    '加班类型': 'type',
    '开始时间': 'startTime',
    '结束时间': 'endTime',
    '事由': 'reason',
  };
  if (label?.endsWith('类型')) return 'type';
  return (label && names[label]) || label || type;
}

function networkFieldForAction(
  session: RecordSession,
  actionIndex: number,
  name: string,
): string | undefined {
  const action = session.actions[actionIndex];
  if (!action) return undefined;
  const windowEnd = Math.min(
    session.actions[actionIndex + 1]?.ts ?? Number.POSITIVE_INFINITY,
    action.ts + 2_000,
  );
  for (const request of session.network) {
    if (request.requestTs < action.ts || request.requestTs >= windowEnd || !request.postData) continue;
    if (!(request.headers['content-type'] ?? '').includes('application/json')) continue;
    const body: unknown = JSON.parse(request.postData);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) continue;
    const value = (body as Record<string, unknown>)[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}
