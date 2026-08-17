import type { RecordedAction, RecordedRequest, RecordSession } from '@dsh/core';

const ACTION_REQUEST_WINDOW_MS = 2_000;

export interface CorrelatedStep {
  id: string;
  action: RecordedAction | null;
  requests: RecordedRequest[];
  orphan: boolean;
}

/**
 * 按请求发起时间将网络请求归给最近的前置动作。
 */
export function correlate(session: RecordSession): CorrelatedStep[] {
  const steps: CorrelatedStep[] = session.actions.map((action, index) => ({
    id: `action-${index + 1}`,
    action,
    requests: [],
    orphan: false,
  }));
  const orphanRequests: RecordedRequest[] = [];

  for (const request of session.network) {
    const actionIndex = ownerActionIndex(session.actions, request.requestTs);
    const owner = actionIndex === -1 ? undefined : steps[actionIndex];
    if (owner) owner.requests.push(request);
    else orphanRequests.push(request);
  }

  if (orphanRequests.length > 0) {
    steps.push({ id: 'orphan', action: null, requests: orphanRequests, orphan: true });
  }
  return steps;
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
