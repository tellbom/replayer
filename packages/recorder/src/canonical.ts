import { createSanitizer } from '@dsh/core';
import type { CanonicalAction, RecordedRequest } from '@dsh/core';

export function finalizeCanonicalActions(
  actions: CanonicalAction[],
  requests: RecordedRequest[],
  additionalSensitivePatterns: string[] = [],
): CanonicalAction[] {
  const sanitizer = createSanitizer(additionalSensitivePatterns);
  const requestIds = new Map<number, string[]>();
  for (const request of requests) {
    if (request.actionIdx === null || request.actionIdx === undefined) continue;
    const ids = requestIds.get(request.actionIdx) ?? [];
    ids.push(request.requestId);
    requestIds.set(request.actionIdx, ids);
  }
  return actions.map((action) => sanitizeAction({
    ...action,
    effects: {
      ...action.effects,
      ...(requestIds.has(action.actionIdx) ? { requestIds: requestIds.get(action.actionIdx) } : {}),
    },
  }, sanitizer.sanitizeText));
}

function sanitizeAction(
  action: CanonicalAction,
  sanitizeText: (value: string) => string,
): CanonicalAction {
  return mapStrings(action, sanitizeText) as CanonicalAction;
}

function mapStrings(value: unknown, sanitizeText: (value: string) => string): unknown {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, sanitizeText));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, mapStrings(child, sanitizeText)]));
}
