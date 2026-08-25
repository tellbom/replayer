import { CAUSALITY } from '@dsh/core';
import type { ParamDefinition } from '@dsh/core';
import type { RecordedAction, RecordSession } from '@dsh/core';

const SENSITIVE_PARAM = /token|csrf|session|timestamp/i;
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
  const sourceActions: RecordedAction[] = [
    ...session.actions,
    ...(session.initialFormState ?? []).map((state) => ({ ...state })),
  ];
  const secondActions: RecordedAction[] = [
    ...(secondSession?.actions ?? []),
    ...(secondSession?.initialFormState ?? []).map((state) => ({ ...state })),
  ];
  sourceActions.forEach((action, index) => {
    if (!isInputAction(action) || action.value === undefined || action.value === '') return;
    const name = paramName(action, session);
    if (SENSITIVE_PARAM.test(name) || SENSITIVE_PARAM.test(action.label ?? '')) return;
    const secondAction = secondActions.find((candidate) =>
      candidate.type === action.type &&
      (action.name ? candidate.name === action.name : candidate.label === action.label),
    );
    const changed =
      secondAction?.type === action.type &&
      secondAction.value !== undefined &&
      secondAction.value !== action.value;
    const existing = candidates.get(name);
    const values =
      action.type === 'select' || action.type === 'radio'
        ? enumValues(action, secondAction, session, secondSession, name)
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
  return action.type === 'fill' || action.type === 'select' || action.type === 'radio'
    || action.type === 'checkbox' || action.type === 'datetime';
}

function paramType(action: RecordedAction): ParamDefinition['type'] {
  if (action.type === 'select' || action.type === 'radio') return 'enum';
  if (action.type === 'checkbox') return 'boolean';
  if (action.type === 'datetime' || DATE_VALUE.test(action.value ?? '')) return 'datetime';
  return 'string';
}

function enumValues(
  action: RecordedAction,
  secondAction: RecordedAction | undefined,
  session: RecordSession,
  secondSession: RecordSession | undefined,
  name: string,
): Array<{ label: string; value: string }> {
  const values: Array<{ label: string; value: string }> = [];
  if (action.value !== undefined) {
    const responseOptions = enumOptionsFromResponses(session, action.value);
    values.push(...(responseOptions.length > 0
      ? responseOptions
      : [{
          label: action.text ?? action.value,
          value: networkValueForAction(session, action, name) ?? action.value,
        }]));
  }
  if ((secondAction?.type === 'select' || secondAction?.type === 'radio') && secondAction.value !== undefined && secondSession) {
    const responseOptions = enumOptionsFromResponses(secondSession, secondAction.value);
    values.push(...(responseOptions.length > 0
      ? responseOptions
      : [{
          label: secondAction.text ?? secondAction.value,
          value: networkValueForAction(secondSession, secondAction, name) ?? secondAction.value,
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
      const options = inferScalarPairs(body, selectedLabel);
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

function paramName(action: RecordedAction, session: RecordSession): string {
  return action.name
    || networkFieldForAction(session, action)
    || normalizeIdentifier(action.label)
    || action.type;
}

function networkFieldForAction(
  session: RecordSession,
  action: RecordedAction,
): string | undefined {
  const matches = requestLeavesAfterAction(session, action)
    .filter((leaf) => String(leaf.value) === action.value)
    .map((leaf) => leaf.key);
  const exact = [...new Set(matches)];
  if (exact.length === 1) return exact[0];
  if (action.type !== 'select' && action.type !== 'radio') return undefined;
  const nearby = [...new Set(requestLeavesNearAction(session, action).map((leaf) => leaf.key))];
  return nearby.length === 1 ? nearby[0] : undefined;
}

function requestLeavesAfterAction(
  session: RecordSession,
  action: RecordedAction,
): Array<{ key: string; value: unknown }> {
  const actionIdx = session.actions.indexOf(action);
  return requestLeaves(session.network.filter((request) =>
    request.actionIdx === actionIdx
    || (request.actionIdx === undefined
      && Math.abs(request.requestTs - action.ts) <= CAUSALITY.activeWindowMs),
  ));
}

function networkValueForAction(
  session: RecordSession,
  action: RecordedAction,
  name: string,
): string | undefined {
  const direct = requestLeavesNearAction(session, action).find((leaf) => leaf.key === name)?.value;
  return typeof direct === 'string' || typeof direct === 'number' ? String(direct) : undefined;
}

function requestLeavesNearAction(
  session: RecordSession,
  action: RecordedAction,
): Array<{ key: string; value: unknown }> {
  const actionIndex = session.actions.indexOf(action);
  const windowEnd = Math.min(
    (actionIndex >= 0 ? session.actions[actionIndex + 1]?.ts : undefined) ?? Number.POSITIVE_INFINITY,
    action.ts + 2_000,
  );
  return requestLeaves(session.network.filter(
    (request) => request.actionIdx === actionIndex
      || (request.actionIdx === undefined
        && request.requestTs >= action.ts && request.requestTs < windowEnd),
  ));
}

function requestLeaves(requests: RecordSession['network']): Array<{ key: string; value: unknown }> {
  const leaves: Array<{ key: string; value: unknown }> = [];
  for (const request of requests) {
    if (!request.postData) continue;
    if (!(request.headers['content-type'] ?? '').includes('application/json')) continue;
    try {
      collectRequestLeaves(JSON.parse(request.postData), leaves);
    } catch {
      continue;
    }
  }
  return leaves;
}

function collectRequestLeaves(value: unknown, output: Array<{ key: string; value: unknown }>): void {
  if (Array.isArray(value)) {
    value.forEach((child) => collectRequestLeaves(child, output));
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === 'object' && child !== null) collectRequestLeaves(child, output);
    else output.push({ key, value: child });
  }
}

function normalizeIdentifier(label: string | undefined): string | undefined {
  const normalized = label?.trim().replace(/\s+/g, '_');
  return normalized || undefined;
}

function inferScalarPairs(items: unknown[], selectedLabel: string): Array<{ label: string; value: string }> {
  const records = items.filter(
    (item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item),
  );
  const selected = records.find((item) => Object.values(item).some((value) => String(value) === selectedLabel));
  if (!selected) return [];
  const labelKey = Object.entries(selected).find(([, value]) => String(value) === selectedLabel)?.[0];
  const valueKeys = Object.entries(selected)
    .filter(([key, value]) => key !== labelKey && (typeof value === 'string' || typeof value === 'number'))
    .map(([key]) => key);
  if (!labelKey || valueKeys.length !== 1) return [];
  const valueKey = valueKeys[0]!;
  return records.flatMap((item) => {
    const label = item[labelKey];
    const value = item[valueKey];
    return (typeof label === 'string' || typeof label === 'number')
      && (typeof value === 'string' || typeof value === 'number')
      ? [{ label: String(label), value: String(value) }]
      : [];
  });
}
