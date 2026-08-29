import { CAUSALITY, DEPENDENCY, IDENTIFIER_STABILITY } from '@dsh/core';
import type { ParamDefinition } from '@dsh/core';
import type { RecordSession } from '@dsh/core';

import { analysisSession, type AnalyzedAction, type AnalysisSession } from './action-view.js';

const SENSITIVE_PARAM = /token|csrf|session|timestamp/i;
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;

function initialStateAction(
  state: NonNullable<RecordSession['initialFormState']>[number],
  actionIdx: number,
): AnalyzedAction {
  return {
    actionIdx,
    timestamp: state.ts,
    kind: state.type === 'select' ? 'select' : 'check',
    locator: state.target,
    ...(state.label ? { label: state.label } : {}),
    ...(state.name ? { name: state.name } : {}),
    value: state.value,
    ...(state.checked !== undefined ? { checked: state.checked } : {}),
    ...(state.text ? { text: state.text } : {}),
    requestIds: [],
    rawEventTypes: [],
  };
}

export interface ParamCandidate {
  definition: ParamDefinition;
  confidence: number;
  sources: string[];
  sourceIndexes: number[];
  enumStatus?: 'static' | 'contextual' | 'incomplete';
  enumSignature?: string;
}

export interface IdentifierStability {
  confirmed: ReadonlySet<number>;
  suspected: ReadonlySet<number>;
}

/** 从用户实际输入动作提取参数候选。 */
export function detectParams(
  session: RecordSession,
  secondSession?: RecordSession,
): ParamCandidate[] {
  const analyzed = analysisSession(session);
  const secondAnalyzed = secondSession ? analysisSession(secondSession) : undefined;
  const candidates = new Map<string, ParamCandidate>();
  const sourceActions: AnalyzedAction[] = [
    ...analyzed.actions,
    ...(session.initialFormState ?? []).map((state, offset) => initialStateAction(state, analyzed.actions.length + offset)),
  ];
  const secondActions: AnalyzedAction[] = [
    ...(secondAnalyzed?.actions ?? []),
    ...(secondSession?.initialFormState ?? []).map((state, offset) =>
      initialStateAction(state, (secondAnalyzed?.actions.length ?? 0) + offset)),
  ];
  const stability = analyzeIdentifierStability(session, secondSession);
  sourceActions.forEach((action, index) => {
    if (!isInputAction(action) || action.value === undefined || action.value === '') return;
    const baseName = paramName(action, analyzed, stability.confirmed.has(index));
    if (SENSITIVE_PARAM.test(baseName) || SENSITIVE_PARAM.test(action.label ?? '')) return;
    const lineage = sourceLineage(action, index);
    const secondAction = matchingSecondAction(action, secondActions);
    const changed =
      secondAction?.kind === action.kind &&
      secondAction.value !== undefined &&
      secondAction.value !== action.value;
    const existing = candidates.get(lineage);
    const enumEvidence =
      action.kind === 'select' || action.kind === 'check' && action.semanticTarget?.inputType === 'radio'
        ? enumValues(action, secondAction, analyzed, secondAnalyzed, baseName)
        : undefined;
    const values = enumEvidence?.values;
    if (existing) {
      existing.sources.push(`action[${index}]`);
      existing.sourceIndexes.push(index);
      if (changed) existing.confidence = 1;
      if (existing.enumSignature && enumEvidence?.signature
        && existing.enumSignature !== enumEvidence.signature) {
        existing.enumStatus = 'contextual';
        delete existing.definition.values;
        delete existing.definition.enumMap;
      } else if (values && existing.definition.values && existing.enumStatus !== 'contextual') {
        existing.definition.values = mergeEnumValues(existing.definition.values, values);
        existing.definition.enumMap = enumMap(existing.definition.values);
      }
      return;
    }
    const name = uniqueParamName(baseName, [...candidates.values()].map((item) => item.definition.name));
    candidates.set(lineage, {
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
      sourceIndexes: [index],
      ...(enumEvidence ? {
        enumStatus: enumEvidence.status,
        enumSignature: enumEvidence.signature,
      } : {}),
    });
  });
  return [...candidates.values()];
}

export function analyzeIdentifierStability(
  session: RecordSession,
  secondSession?: RecordSession,
): IdentifierStability {
  const first = analysisSession(session);
  const second = secondSession ? analysisSession(secondSession) : undefined;
  const confirmed = new Set<number>();
  const suspected = new Set<number>();
  first.actions.forEach((action, index) => {
    if (action.name && hasHighEntropySegment(action.name)) suspected.add(index);
    const peer = second?.actions[index];
    if (!action.name || !peer?.name || peer.kind !== action.kind || peer.name === action.name) return;
    const sameSemantics = action.semanticTarget?.tag === peer.semanticTarget?.tag
      && action.semanticTarget?.role === peer.semanticTarget?.role;
    if (sameSemantics || (!action.semanticTarget && !peer.semanticTarget)) confirmed.add(index);
  });
  return { confirmed, suspected };
}

function hasHighEntropySegment(value: string): boolean {
  const segments = value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return segments.some((segment) => {
    if (segment.length < IDENTIFIER_STABILITY.minEntropySegmentLength) return false;
    const diversity = Number(/[a-z]/.test(segment)) + Number(/\d/.test(segment));
    return diversity >= IDENTIFIER_STABILITY.minCharsetDiversity;
  });
}

function sourceLineage(action: AnalyzedAction, index: number): string {
  if (!action.locator && !action.semanticTarget) return `unresolved:${index}`;
  return JSON.stringify({
    target: normalizedActionTarget(action),
    control: action.semanticTarget ? {
      tagName: action.semanticTarget.tag,
      type: action.semanticTarget.inputType,
      name: action.semanticTarget.name,
    } : null,
    role: action.semanticTarget?.role ?? null,
    kind: action.kind,
  });
}

function normalizedActionTarget(action: AnalyzedAction): unknown {
  if (action.kind === 'select' && action.semanticTarget?.role === 'option' && action.label) {
    return { standardOptionOwnerLabel: action.label };
  }
  return action.locator ? normalizedTarget(action.locator) : action.semanticTarget;
}

function normalizedTarget(target: NonNullable<AnalyzedAction['locator']>): unknown {
  return target;
}

function matchingSecondAction(
  action: AnalyzedAction,
  secondActions: AnalyzedAction[],
): AnalyzedAction | undefined {
  if (action.locator || action.semanticTarget) {
    const target = JSON.stringify(normalizedActionTarget(action));
    const matches = secondActions.filter((candidate) =>
      candidate.kind === action.kind
      && (candidate.locator !== undefined || candidate.semanticTarget !== undefined)
      && JSON.stringify(normalizedActionTarget(candidate)) === target,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  const matches = secondActions.filter((candidate) =>
    candidate.kind === action.kind
    && candidate.locator === undefined
    && candidate.name === action.name
    && candidate.label === action.label,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueParamName(base: string, used: string[]): string {
  if (!used.includes(base)) return base;
  let suffix = 2;
  while (used.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function isInputAction(action: AnalyzedAction): boolean {
  return action.kind === 'edit' || action.kind === 'select' || action.kind === 'check';
}

function paramType(action: AnalyzedAction): ParamDefinition['type'] {
  if (action.kind === 'select' || action.semanticTarget?.inputType === 'radio') return 'enum';
  if (action.kind === 'check') return 'boolean';
  if (DATE_VALUE.test(action.value ?? '')) return 'datetime';
  return 'string';
}

function enumValues(
  action: AnalyzedAction,
  secondAction: AnalyzedAction | undefined,
  session: AnalysisSession,
  secondSession: AnalysisSession | undefined,
  name: string,
): {
  values?: Array<{ label: string; value: string }>;
  status: 'static' | 'contextual' | 'incomplete';
  signature?: string;
} {
  const firstDom = completeDomOptions(action);
  const secondDom = secondAction ? completeDomOptions(secondAction) : undefined;
  if (firstDom && secondDom && secondAction && secondSession) {
    const firstSignature = optionSignature(firstDom);
    const secondSignature = optionSignature(secondDom);
    if (firstSignature !== secondSignature) {
      return { status: 'contextual', signature: firstSignature };
    }
    if (recordingsVary(session, secondSession)) {
      return {
        status: 'static',
        values: staticDomValues(firstDom, action, secondAction, session, secondSession, name),
        signature: firstSignature,
      };
    }
  }

  const responseOptions = staticResponseOptions(session, action);
  if (responseOptions.length > 0) {
    return {
      status: 'static',
      values: responseOptions,
      signature: optionSignature(responseOptions),
    };
  }

  const recorded = action.value === undefined ? [] : [{
    label: action.text ?? action.value,
    value: networkValueForAction(session, action, name) ?? action.value,
  }];
  if (secondAction?.value !== undefined && secondSession) {
    recorded.push({
      label: secondAction.text ?? secondAction.value,
      value: networkValueForAction(secondSession, secondAction, name) ?? secondAction.value,
    });
  }
  return {
    status: 'incomplete',
    values: recorded,
    ...(firstDom ? { signature: optionSignature(firstDom) } : {}),
  };
}

function staticDomValues(
  items: Array<{ label: string; value: string }>,
  firstAction: AnalyzedAction,
  secondAction: AnalyzedAction,
  firstSession: AnalysisSession,
  secondSession: AnalysisSession,
  name: string,
): Array<{ label: string; value: string }> {
  const observed = new Map<string, string>();
  let domValueDiffersFromTransport = false;
  for (const [action, session] of [
    [firstAction, firstSession],
    [secondAction, secondSession],
  ] as const) {
    if (action.value === undefined) continue;
    const selected = items.find((item) =>
      item.label === (action.text ?? action.value) || item.value === action.value);
    const networkValue = networkValueForAction(session, action, name);
    if (!selected || networkValue === undefined) continue;
    observed.set(selected.label, networkValue);
    domValueDiffersFromTransport ||= selected.value !== networkValue;
  }
  if (!domValueDiffersFromTransport) return items;
  return items.flatMap((item) => {
    const value = observed.get(item.label);
    return value === undefined ? [] : [{ label: item.label, value }];
  });
}

function completeDomOptions(
  action: AnalyzedAction,
): Array<{ label: string; value: string }> | undefined {
  const evidence = action.legacy?.enumOptions;
  return evidence?.complete && evidence.items.length > 0
    ? mergeEnumValues([], evidence.items)
    : undefined;
}

function optionSignature(items: Array<{ label: string; value: string }>): string {
  return JSON.stringify([...items]
    .map((item) => [item.label, item.value])
    .sort((left, right) => `${left[0]}\u0000${left[1]}`.localeCompare(`${right[0]}\u0000${right[1]}`)));
}

function recordingsVary(first: AnalysisSession, second: AnalysisSession): boolean {
  return first.actions.some((action, index) => {
    const peer = second.actions[index];
    return peer?.kind === action.kind && action.value !== undefined && peer.value !== action.value;
  });
}

function staticResponseOptions(
  session: AnalysisSession,
  action: AnalyzedAction,
): Array<{ label: string; value: string }> {
  if (!action.locator || action.value === undefined) return [];
  for (const request of session.network) {
    if (!request.responseBody || request.actionIdx === null || request.actionIdx === undefined) continue;
    const owner = session.actions[request.actionIdx];
    if (!owner?.legacy?.waitAfter?.notEmpty || request.causality !== 'active-action') continue;
    if (JSON.stringify(owner.legacy.waitAfter.notEmpty) !== JSON.stringify(action.locator)) continue;
    if (requestHasVariableContext(request, session.actions)) continue;
    try {
      const body: unknown = JSON.parse(request.responseBody);
      if (!Array.isArray(body)) continue;
      const options = inferScalarPairs(body, action.text ?? action.value);
      if (options.some((item) => item.label === (action.text ?? action.value))) return options;
    } catch {
      continue;
    }
  }
  return [];
}

function requestHasVariableContext(request: RecordSession['network'][number], actions: AnalyzedAction[]): boolean {
  const values = new Set(actions
    .filter((action) => action.timestamp <= request.requestTs && action.value !== undefined)
    .map((action) => action.value!));
  try {
    const url = new URL(request.url);
    if ([...url.searchParams.values()].some((value) => values.has(value))) return true;
  } catch {
    return true;
  }
  if (!request.postData) return false;
  return [...values].some((value) => request.postData!.includes(value));
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

function paramName(action: AnalyzedAction, session: AnalysisSession, ignoreDomName = false): string {
  return (!ignoreDomName ? action.name : undefined)
    || networkFieldForAction(session, action)
    || uniqueWriteFieldForAction(session, action)
    || normalizeIdentifier(action.label)
    || `${action.kind}_${action.actionIdx + 1}`;
}

function uniqueWriteFieldForAction(
  session: AnalysisSession,
  action: AnalyzedAction,
): string | undefined {
  if (action.value === undefined || !isDiscriminativeValue(action.value)) return undefined;
  const matches = requestLeaves(session.network.filter((request) => request.mutating))
    .filter((leaf) => String(leaf.value) === action.value)
    .map((leaf) => leaf.key);
  const unique = [...new Set(matches)];
  return unique.length === 1 ? unique[0] : undefined;
}

function isDiscriminativeValue(value: string): boolean {
  const numeric = Number(value);
  if (value.trim() !== '' && Number.isFinite(numeric)) {
    return Math.abs(numeric) >= DEPENDENCY.minNumberAbs;
  }
  return value.length >= DEPENDENCY.minStringLength;
}

function networkFieldForAction(
  session: AnalysisSession,
  action: AnalyzedAction,
): string | undefined {
  const matches = requestLeavesAfterAction(session, action)
    .filter((leaf) => String(leaf.value) === action.value)
    .map((leaf) => leaf.key);
  const exact = [...new Set(matches)];
  if (exact.length === 1) return exact[0];
  if (action.kind !== 'select' && action.semanticTarget?.inputType !== 'radio') return undefined;
  const nearby = [...new Set(requestLeavesNearAction(session, action).map((leaf) => leaf.key))];
  return nearby.length === 1 ? nearby[0] : undefined;
}

function requestLeavesAfterAction(
  session: AnalysisSession,
  action: AnalyzedAction,
): Array<{ key: string; value: unknown }> {
  const actionIdx = session.actions.indexOf(action);
  return requestLeaves(session.network.filter((request) =>
    request.actionIdx === actionIdx
    || (request.actionIdx === undefined
      && Math.abs(request.requestTs - action.timestamp) <= CAUSALITY.activeWindowMs),
  ));
}

function networkValueForAction(
  session: AnalysisSession,
  action: AnalyzedAction,
  name: string,
): string | undefined {
  const direct = requestLeavesNearAction(session, action).find((leaf) => leaf.key === name)?.value;
  return typeof direct === 'string' || typeof direct === 'number' ? String(direct) : undefined;
}

function requestLeavesNearAction(
  session: AnalysisSession,
  action: AnalyzedAction,
): Array<{ key: string; value: unknown }> {
  const actionIndex = session.actions.indexOf(action);
  const windowEnd = Math.min(
    (actionIndex >= 0 ? session.actions[actionIndex + 1]?.timestamp : undefined) ?? Number.POSITIVE_INFINITY,
    action.timestamp + 2_000,
  );
  return requestLeaves(session.network.filter(
    (request) => request.actionIdx === actionIndex
      || (request.actionIdx === undefined
        && request.requestTs >= action.timestamp && request.requestTs < windowEnd),
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
