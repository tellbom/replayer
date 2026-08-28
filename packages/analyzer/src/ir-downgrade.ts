/**
 * Transitional adapter. Delete after Phase 2 ValueLineage is complete.
 * This module performs structural conversion only and never infers intent.
 */
import type { CanonicalAction, LocatorStrategy, RecordedAction } from '@dsh/core';

export type DowngradedLegacyActions = RecordedAction[] & { _notes: string[] };

export function downgradeToLegacyActions(actions: CanonicalAction[]): DowngradedLegacyActions {
  const output = [] as unknown as DowngradedLegacyActions;
  Object.defineProperty(output, '_notes', { value: [] as string[], enumerable: false });
  for (const action of actions) {
    const converted = structurallyDowngrade(action);
    if (converted) output.push(converted);
    else output._notes.push(`actionIdx=${action.actionIdx} kind=${action.kind} has no legacy structural equivalent`);
    if (action.before || action.after?.affected || action.effects?.domMutations) {
      output._notes.push(`actionIdx=${action.actionIdx} lost=before/after/affected`);
    }
  }
  return output;
}

function structurallyDowngrade(action: CanonicalAction): RecordedAction | undefined {
  const common = {
    ts: action.timestamp,
    ...(legacyTarget(action) ? { target: legacyTarget(action) } : {}),
  };
  const state = action.after?.self;
  switch (action.kind) {
    case 'activate':
      return { ...common, type: 'click', text: state?.textContent };
    case 'edit':
      return { ...common, type: 'fill', value: scalarValue(state?.value) };
    case 'select':
      {
        const selected = scalarValue(state?.value) ?? state?.textContent;
      return {
        ...common,
        type: 'select',
        value: selected,
        text: state?.textContent || selected,
      };
      }
    case 'check':
      return {
        ...common,
        type: action.target?.inputType === 'radio' ? 'radio' : 'checkbox',
        value: scalarValue(state?.value), checked: state?.checked,
      };
    case 'navigate':
      return { ...common, type: 'navigate', url: action.effects?.navigation?.url ?? action.after?.page?.url };
    case 'key':
    case 'upload':
    case 'unknown':
      return undefined;
  }
}

function legacyTarget(action: CanonicalAction): LocatorStrategy | undefined {
  const evidence = action.target?.locatorEvidence;
  return evidence
    ? { strategy: 'playwright', selector: evidence.generatedSelector, confidence: evidence.confidence }
    : undefined;
}

function scalarValue(value: string | string[] | null | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value ?? undefined;
}
