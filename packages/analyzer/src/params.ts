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
    const values = action.type === 'select' ? enumValues(action, secondAction) : undefined;
    if (existing) {
      existing.sources.push(`action[${index}]`);
      if (changed) existing.confidence = 1;
      if (values && existing.definition.values) {
        existing.definition.values = mergeEnumValues(existing.definition.values, values);
      }
      return;
    }
    candidates.set(name, {
      definition: {
        name,
        type: paramType(action),
        values,
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
): Array<{ label: string; value: string }> {
  const values = [action.value];
  if (secondAction?.type === 'select') values.push(secondAction.value);
  return [...new Set(values.filter((value): value is string => value !== undefined))].map((value) => ({
    label: value,
    value,
  }));
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
  return (label && names[label]) || label || type;
}
