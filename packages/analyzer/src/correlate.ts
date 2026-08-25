import { CAUSALITY, DEPENDENCY } from '@dsh/core';
import type { RecordedAction, RecordedRequest, RecordSession } from '@dsh/core';

const ACTION_REQUEST_WINDOW_MS = 2_000;

export interface CorrelatedStep {
  id: string;
  action: RecordedAction | null;
  requests: CorrelatedRequest[];
  orphan: boolean;
  hasSideEffect: boolean;
}

export interface RequestDependency {
  from: string;
  path: string;
  to: string;
  ambiguous?: boolean;
  discriminator?: { field: string; actionIndex: number };
}

export interface CorrelatedRequest extends RecordedRequest {
  dependsOn: RequestDependency[];
  isSubmit: boolean;
  correlation?: RequestCorrelation;
}

export interface RequestCorrelation {
  method: 'action-causality' | 'dom-causality' | 'response-value-match' | 'request-value-match' | 'time-window';
  confidence: 'high' | 'low';
  ownerActionIndex: number;
  evidence: string;
}

/**
 * 按请求发起时间将网络请求归给最近的前置动作。
 */
export function correlate(session: RecordSession): CorrelatedStep[] {
  const requests = analyzeDependencies(session.network, session.actions);
  const steps: CorrelatedStep[] = session.actions.map((action, index) => ({
    id: `action-${index + 1}`,
    action,
    requests: [],
    orphan: false,
    hasSideEffect: false,
  }));
  const orphanRequests: CorrelatedRequest[] = [];

  for (const request of requests) {
    const correlation = correlateRequest(session, request, requests);
    const actionIndex = correlation?.ownerActionIndex ?? -1;
    request.correlation = correlation;
    const owner = actionIndex === -1 ? undefined : steps[actionIndex];
    if (owner) {
      owner.requests.push(request);
      owner.hasSideEffect ||= request.mutating;
    }
    else orphanRequests.push(request);
  }

  if (orphanRequests.length > 0) {
    // 按 requestTs 插回动作序列：orphan 是动作窗口外的初始化请求，
    // 追加到末尾会让依赖模板引用后置步骤，回放时必然解析失败。
    const orphanStep: CorrelatedStep = {
      id: 'orphan',
      action: null,
      requests: orphanRequests,
      orphan: true,
      hasSideEffect: orphanRequests.some((request) => request.mutating),
    };
    const insertBefore = session.actions.findIndex(
      (action) => action.ts > orphanRequests[0]!.requestTs,
    );
    steps.splice(insertBefore === -1 ? steps.length : insertBefore, 0, orphanStep);
  }
  return steps;
}

function correlateRequest(
  session: RecordSession,
  request: CorrelatedRequest,
  correlatedRequests: CorrelatedRequest[],
): RequestCorrelation | undefined {
  const requestValues = new Set(requestInputLeaves(request).map((leaf) => String(leaf.value)));
  const aliases = enumAliases(session.network);
  const responseValueOwners = session.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.value !== undefined
      && aliases.has(action.value)
      && actionValues(action.value, aliases).some((value) => requestValues.has(value)));
  const responseValueOwner = responseValueOwners.length === 1 ? responseValueOwners[0] : undefined;

  if (request.actionIdx !== null && request.actionIdx !== undefined) {
    const owner = session.actions[request.actionIdx];
    if (owner) {
      const activeValue = request.causalityDebug?.valueAtRequest;
      const activeValueMatches = activeValue !== null && activeValue !== undefined
        && actionValues(activeValue, aliases).some((value) => requestValues.has(value));
      if (responseValueOwner && responseValueOwner.index !== request.actionIdx
        && request.causalityDebug?.kind !== 'click' && !activeValueMatches) {
        return {
          method: 'response-value-match',
          confidence: 'high',
          ownerActionIndex: responseValueOwner.index,
          evidence: 'request leaf matched a unique action value through an observed response pair',
        };
      }
      return {
        method: 'action-causality',
        confidence: 'high',
        ownerActionIndex: request.actionIdx,
        evidence: `request carried browser-observed actionIdx=${request.actionIdx}`,
      };
    }
  }

  if (responseValueOwner) {
    return {
      method: 'response-value-match',
      confidence: 'high',
      ownerActionIndex: responseValueOwner.index,
      evidence: 'request leaf matched a unique action value through an observed response pair',
    };
  }

  const eligible = session.actions
    .map((action, index) => ({ action, index }))
    .filter(({ action }) => action.ts <= request.requestTs);

  const responseDependencies = request.mutating
    ? request.dependsOn.flatMap((dependency) => {
        if (dependency.ambiguous) return [];
        const source = correlatedRequests.find((candidate) => candidate.requestId === dependency.from);
        if (!source) return [];
        const sourceOwner = dependency.discriminator?.actionIndex
          ?? source.correlation?.ownerActionIndex
          ?? ownerActionIndex(session.actions, source.requestTs);
        return sourceOwner === -1 ? [] : [{ dependency, source, sourceOwner }];
      })
    : [];
  if (responseDependencies.length > 0) {
    const latestSource = responseDependencies.sort(
      (left, right) => right.source.requestTs - left.source.requestTs,
    )[0]!;
    const immediateOwner = ownerActionIndex(session.actions, request.requestTs);
    const owner = immediateOwner !== -1 && session.actions[immediateOwner]?.type === 'click'
      ? immediateOwner
      : latestSource.dependency.discriminator?.actionIndex
        ?? firstSuccessorAction(
          session.actions,
          latestSource.sourceOwner,
          latestSource.source.requestTs,
          request.requestTs,
        );
    if (owner !== -1) {
      return {
        method: 'response-value-match',
        confidence: 'high',
        ownerActionIndex: owner,
        evidence: `写请求体值可溯源到先前响应 ${[
          ...new Set(responseDependencies.map((item) => item.dependency.from)),
        ].join('、')}`,
      };
    }
  }

  const responseValues = responseBodyLeaves(request)
    .map((leaf) => leaf.value)
    .filter((value) =>
      (typeof value === 'string' && value.length >= DEPENDENCY.minStringLength) ||
      (typeof value === 'number' && Math.abs(value) >= DEPENDENCY.minNumberAbs),
    )
    .map(String);
  const domOwner = [...eligible].reverse().find(({ action }) => {
    if (!action.produces) return false;
    const mutation = JSON.stringify(action.produces);
    return responseValues.some((value) => value.length > 0 && mutation.includes(value));
  });
  if (domOwner) {
    const mutation = JSON.stringify(domOwner.action.produces);
    const value = responseValues.find((candidate) => mutation.includes(candidate));
    return {
      method: 'dom-causality',
      confidence: 'high',
      ownerActionIndex: domOwner.index,
      evidence: `响应值 ${value ?? ''} 出现在该动作的 DOM 变更中`,
    };
  }

  // Legacy recordings may emit change after HTTP; keep this fallback bounded.
  const valueOwners = session.actions.map((action, index) => ({ action, index })).filter(({ action }) =>
    action.value !== undefined
    && Math.abs(request.requestTs - action.ts) <= CAUSALITY.activeWindowMs
    && isDiscriminativeActionValue(action.value)
    && actionValues(action.value, aliases).some((value) => requestValues.has(value)),
  );
  const valueOwner = valueOwners.length === 1 ? valueOwners[0] : undefined;
  if (valueOwner) {
    const matched = actionValues(valueOwner.action.value!, aliases).find((value) => requestValues.has(value));
    return {
      method: 'request-value-match',
      confidence: 'low',
      ownerActionIndex: valueOwner.index,
      evidence: `请求体值 ${matched ?? ''} 匹配动作输入 ${valueOwner.action.value}`,
    };
  }

  const timeOwner = ownerActionIndex(session.actions, request.requestTs);
  if (timeOwner === -1) return undefined;
  const distance = request.requestTs - session.actions[timeOwner]!.ts;
  return {
    method: 'time-window',
    confidence: 'low',
    ownerActionIndex: timeOwner,
    evidence: `请求距最近前置动作 ${distance}ms，无 DOM 或请求值因果证据`,
  };
}

function firstSuccessorAction(
  actions: RecordedAction[],
  sourceOwner: number,
  sourceStartedAt: number,
  targetRequestAt: number,
): number {
  const valueAction = actions.findIndex((action, index) =>
    index > sourceOwner
    && action.ts >= sourceStartedAt
    && action.ts <= targetRequestAt
    && action.value !== undefined,
  );
  if (valueAction !== -1) return valueAction;
  for (let index = sourceOwner + 1; index < actions.length; index += 1) {
    const action = actions[index];
    if (action && action.ts >= sourceStartedAt && action.ts <= targetRequestAt) return index;
  }
  return sourceOwner;
}

function enumAliases(requests: RecordedRequest[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const request of requests) {
    if (!request.responseBody) continue;
    let body: unknown;
    try {
      body = JSON.parse(request.responseBody);
    } catch {
      continue;
    }
    if (!Array.isArray(body)) continue;
    for (const item of body) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
      const scalars = Object.values(item).filter(
        (value): value is string | number => typeof value === 'string' || typeof value === 'number',
      );
      if (scalars.length !== 2) continue;
      aliases.set(String(scalars[0]), String(scalars[1]));
      aliases.set(String(scalars[1]), String(scalars[0]));
    }
  }
  return aliases;
}

function actionValues(value: string, aliases: Map<string, string>): string[] {
  const alias = aliases.get(value);
  return alias === undefined ? [value] : [value, alias];
}

function isDiscriminativeActionValue(value: string): boolean {
  if (isFingerprint(value)) return true;
  const numeric = Number(value);
  if (value.trim() !== '' && Number.isFinite(numeric)) {
    return Math.abs(numeric) >= DEPENDENCY.minNumberAbs;
  }
  return value.length >= DEPENDENCY.minStringLength;
}

function analyzeDependencies(
  requests: RecordedRequest[],
  actions: RecordedAction[],
): CorrelatedRequest[] {
  const lastMutating = [...requests]
    .filter((request) => request.mutating)
    .sort((left, right) => right.requestTs - left.requestTs)[0]?.requestId;
  // 弱值去重需要跨全部响应统计出现次数（T-29 规则第 4 条）
  const globalValueCounts = new Map<string, number>();
  for (const request of requests) {
    for (const leaf of responseBodyLeaves(request)) {
      const key = `${typeof leaf.value}:${String(leaf.value)}`;
      globalValueCounts.set(key, (globalValueCounts.get(key) ?? 0) + 1);
    }
  }
  return requests.map((target, targetIndex) => {
    const dependsOn: RequestDependency[] = [];
    const targetLeaves = [...requestBodyLeaves(target), ...requestHeaderLeaves(target)];
    for (const source of requests.slice(0, targetIndex)) {
      const sourceLeaves = responseBodyLeaves(source);
      for (const targetLeaf of targetLeaves) {
        for (const sourceLeaf of sourceLeaves) {
          if (targetLeaf.value !== sourceLeaf.value) continue;
          if (
            isWeakValue(targetLeaf.value, globalValueCounts)
            && !isUniqueSameFieldValue(sourceLeaf, targetLeaf, globalValueCounts)
          ) continue;
          if (source.sanitizeMode !== 'structured' || target.sanitizeMode !== 'structured') {
            continue;
          }
          const selection = indexedSelection(source, sourceLeaf, actions);
          dependsOn.push({
            from: source.requestId,
            path: sourceLeaf.path,
            to: targetLeaf.path,
            ...selection,
          });
        }
      }
    }
    return { ...target, dependsOn, isSubmit: target.requestId === lastMutating };
  });
}

function requestHeaderLeaves(request: RecordedRequest): ValueLeaf[] {
  return Object.entries(request.headers).flatMap(([name, value]) => {
    const match = /^<FROM_PREFLIGHT:[^|>]+\|sha256:([a-f0-9]+)>$/.exec(value);
    return match ? [{ path: `header.${name}`, value: `<REDACTED:sha256:${match[1]}>` }] : [];
  });
}

function isUniqueSameFieldValue(
  source: ValueLeaf,
  target: ValueLeaf,
  counts: Map<string, number>,
): boolean {
  if (typeof source.value === 'boolean' || source.value === '') return false;
  const sourceName = source.path.split('.').at(-1);
  const targetName = target.path.split('.').at(-1);
  const key = `${typeof source.value}:${String(source.value)}`;
  return sourceName !== undefined && sourceName === targetName && counts.get(key) === 1;
}

function indexedSelection(
  source: RecordedRequest,
  leaf: ValueLeaf,
  actions: RecordedAction[],
): Pick<RequestDependency, 'ambiguous' | 'discriminator'> {
  const indexed = /^(.*)\[(\d+)\](.*)$/.exec(leaf.path);
  if (!indexed || !source.responseBody) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source.responseBody);
  } catch {
    return { ambiguous: true };
  }
  const array = readCollectedPath(parsed, indexed[1]!);
  if (!Array.isArray(array)) return { ambiguous: true };
  const selected = array[Number(indexed[2])];
  if (typeof selected !== 'object' || selected === null || Array.isArray(selected)) {
    return { ambiguous: true };
  }
  const candidates = Object.entries(selected).flatMap(([field, value]) => {
    if (typeof value !== 'string' && typeof value !== 'number') return [];
    const actionIndex = actions.findIndex((action) => action.value === String(value));
    if (actionIndex < 0) return [];
    const occurrences = array.filter(
      (item) => typeof item === 'object' && item !== null
        && String((item as Record<string, unknown>)[field]) === String(value),
    ).length;
    return occurrences === 1 ? [{ field, actionIndex }] : [];
  });
  return candidates.length === 1 ? { discriminator: candidates[0] } : { ambiguous: true };
}

function readCollectedPath(root: unknown, path: string): unknown {
  const segments = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** fingerprint 形态豁免弱值规则——依赖识别恰恰依赖它们。 */
function isFingerprint(value: string): boolean {
  return /^<REDACTED:sha256:[0-9a-f]{12}>$/.test(value);
}

/**
 * 【T-29】弱值过滤，按序判断，命中即跳过：
 * 1. 布尔（含 'true'/'false' 字符串形态）
 * 2. 空值（'' —— null/undefined/[]/{} 已被 collectLeaves 排除）
 * 3. 短数字：整数且 |v| < minNumberAbs
 * 4. 某值在所有响应中出现次数 > weakValueThreshold（fingerprint 豁免）
 * 5. 短字符串：长度 < minStringLength 且非 fingerprint
 */
function isWeakValue(value: string | number | boolean, counts: Map<string, number>): boolean {
  if (typeof value === 'boolean') return true;
  if (value === 'true' || value === 'false') return true;
  if (value === '') return true;
  if (typeof value === 'number' && Number.isInteger(value) && Math.abs(value) < DEPENDENCY.minNumberAbs) {
    return true;
  }
  const key = `${typeof value}:${String(value)}`;
  if ((counts.get(key) ?? 0) > DEPENDENCY.weakValueThreshold && !(typeof value === 'string' && isFingerprint(value))) {
    return true;
  }
  if (typeof value === 'string' && value.length < DEPENDENCY.minStringLength && !isFingerprint(value)) {
    return true;
  }
  return false;
}

interface ValueLeaf {
  path: string;
  value: string | number | boolean;
}

function requestBodyLeaves(request: RecordedRequest): ValueLeaf[] {
  if (request.postData === null) return [];
  const contentType = request.headers['content-type'] ?? '';
  if (contentType.includes('application/json')) {
    try {
      return collectLeaves(JSON.parse(request.postData), 'body');
    } catch {
      return [];
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return [...new URLSearchParams(request.postData)].map(([key, value]) => ({
      path: `body.${key}`,
      value,
    }));
  }
  return [];
}

function requestInputLeaves(request: RecordedRequest): ValueLeaf[] {
  const body = requestBodyLeaves(request);
  let parsed: URL;
  try {
    parsed = new URL(request.url);
  } catch {
    return body;
  }
  return [
    ...body,
    ...[...parsed.searchParams].map(([key, value]) => ({ path: `query.${key}`, value })),
  ];
}

function responseBodyLeaves(request: RecordedRequest): ValueLeaf[] {
  if (request.responseBody === null) return [];
  try {
    return collectLeaves(JSON.parse(request.responseBody), '$');
  } catch {
    return [];
  }
}

function collectLeaves(value: unknown, path: string): ValueLeaf[] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return [{ path, value }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectLeaves(item, `${path}[${index}]`));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, child]) => collectLeaves(child, `${path}.${key}`));
  }
  return [];
}

function ownerActionIndex(actions: RecordedAction[], requestTs: number): number {
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index];
    if (!action || action.ts > requestTs) continue;
    const nextActionTs = actions[index + 1]?.ts ?? Number.POSITIVE_INFINITY;
    const windowEnd = Math.min(nextActionTs, action.ts + ACTION_REQUEST_WINDOW_MS);
    return requestTs < windowEnd ? index : -1;
  }
  return -1;
}
