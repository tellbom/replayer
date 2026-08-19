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
  return requests.map((target, targetIndex) => {
    const dependsOn: RequestDependency[] = [];
    const targetLeaves = requestBodyLeaves(target);
    for (const source of requests.slice(0, targetIndex)) {
      const sourceLeaves = responseBodyLeaves(source);
      // 弱值（布尔/数字）在枚举型响应中大量重复，等值即匹配会产生海量假依赖；
      // 仅当该值在整个源响应中唯一出现时才视为依赖（approverId 这类唯一 id 仍可识别）。
      const weakValueCounts = countWeakValues(sourceLeaves);
      for (const targetLeaf of targetLeaves) {
        // 空字符串是弱值：列表型响应里到处都是，等值匹配只会产生假依赖。
        if (targetLeaf.value === '') continue;
        for (const sourceLeaf of sourceLeaves) {
          if (targetLeaf.value !== sourceLeaf.value) continue;
          if (
            (typeof sourceLeaf.value === 'number' || typeof sourceLeaf.value === 'boolean') &&
            (weakValueCounts.get(sourceLeaf.value) ?? 0) > 1
          ) {
            continue;
          }
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

function countWeakValues(leaves: ValueLeaf[]): Map<number | boolean, number> {
  const counts = new Map<number | boolean, number>();
  for (const leaf of leaves) {
    if (typeof leaf.value === 'number' || typeof leaf.value === 'boolean') {
      counts.set(leaf.value, (counts.get(leaf.value) ?? 0) + 1);
    }
  }
  return counts;
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
