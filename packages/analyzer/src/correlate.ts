import { DEPENDENCY } from '@dsh/core';
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
}

export interface CorrelatedRequest extends RecordedRequest {
  dependsOn: RequestDependency[];
  isSubmit: boolean;
}

/**
 * 按请求发起时间将网络请求归给最近的前置动作。
 */
export function correlate(session: RecordSession): CorrelatedStep[] {
  const requests = analyzeDependencies(session.network);
  const steps: CorrelatedStep[] = session.actions.map((action, index) => ({
    id: `action-${index + 1}`,
    action,
    requests: [],
    orphan: false,
    hasSideEffect: false,
  }));
  const orphanRequests: CorrelatedRequest[] = [];

  for (const request of requests) {
    const actionIndex = ownerActionIndex(session.actions, request.requestTs);
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

function analyzeDependencies(requests: RecordedRequest[]): CorrelatedRequest[] {
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
    const targetLeaves = requestBodyLeaves(target);
    for (const source of requests.slice(0, targetIndex)) {
      const sourceLeaves = responseBodyLeaves(source);
      for (const targetLeaf of targetLeaves) {
        if (isWeakValue(targetLeaf.value, globalValueCounts)) continue;
        for (const sourceLeaf of sourceLeaves) {
          if (targetLeaf.value !== sourceLeaf.value) continue;
          if (source.sanitizeMode !== 'structured' || target.sanitizeMode !== 'structured') {
            throw new Error(
              `依赖识别要求 structured 脱敏: ${source.requestId} -> ${target.requestId}`,
            );
          }
          dependsOn.push({
            from: source.requestId,
            path: sourceLeaf.path,
            to: targetLeaf.path,
          });
        }
      }
    }
    return { ...target, dependsOn, isSubmit: target.requestId === lastMutating };
  });
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
    return collectLeaves(JSON.parse(request.postData), 'body');
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    return [...new URLSearchParams(request.postData)].map(([key, value]) => ({
      path: `body.${key}`,
      value,
    }));
  }
  return [];
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
