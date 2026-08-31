import type {
  CanonicalAction, LocatorStrategy, ObservableState, RecordSession, SemanticTarget,
} from '@dsh/core';

/** Analyzer-only projection of canonical action evidence. */
export interface AnalyzedAction {
  actionIdx: number;
  timestamp: number;
  kind: CanonicalAction['kind'];
  semanticTarget?: SemanticTarget;
  locator?: LocatorStrategy;
  label?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  text?: string;
  url?: string;
  before?: ObservableState;
  after?: ObservableState;
  requestIds: string[];
  rawEventTypes: string[];
  unclassifiedReason?: string;
  enumOptions?: CanonicalAction['enumOptions'];
}

export type AnalysisSession = RecordSession & { actions: AnalyzedAction[] };

export function analysisSession(session: RecordSession): AnalysisSession {
  return {
    ...session,
    actions: session.canonicalActions.map(fromCanonical),
  };
}

export function analyzedInputs(session: RecordSession): AnalyzedAction[] {
  const analyzed = analysisSession(session);
  return [
    ...analyzed.actions,
    ...(session.initialFormState ?? []).map((state, offset) => ({
      actionIdx: analyzed.actions.length + offset,
      timestamp: state.ts,
      kind: state.type === 'select' ? 'select' as const : 'check' as const,
      locator: state.target,
      ...(state.label ? { label: state.label } : {}),
      ...(state.name ? { name: state.name } : {}),
      value: state.value,
      ...(state.checked !== undefined ? { checked: state.checked } : {}),
      ...(state.text ? { text: state.text } : {}),
      requestIds: [],
      rawEventTypes: [],
    })),
  ];
}

function fromCanonical(action: CanonicalAction): AnalyzedAction {
  const state = action.after?.self;
  const target = sanitizeSemanticTarget(action.target);
  const value = scalarValue(state?.value);
  const label = cleanText(target?.neighborhood?.labelText)
    ?? cleanText(target?.accessibleName)
    ?? cleanText(target?.placeholder);
  const locatorEvidence = target?.locatorEvidence;
  return {
    actionIdx: action.actionIdx,
    timestamp: action.timestamp,
    kind: action.kind,
    ...(target ? { semanticTarget: target } : {}),
    ...(locatorEvidence ? {
      locator: {
        strategy: 'playwright',
        selector: locatorEvidence.generatedSelector,
        confidence: locatorEvidence.confidence,
      },
    } : {}),
    ...(label ? { label } : {}),
    ...(cleanText(target?.name) ? { name: cleanText(target?.name) } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(state?.checked !== undefined ? { checked: state.checked } : {}),
    ...(cleanText(state?.textContent) ? { text: cleanText(state?.textContent) } : {}),
    ...(action.effects?.navigation?.url ?? action.after?.page?.url
      ? { url: action.effects?.navigation?.url ?? action.after?.page?.url }
      : {}),
    ...(action.before ? { before: action.before } : {}),
    ...(action.after ? { after: action.after } : {}),
    requestIds: [...(action.effects?.requestIds ?? [])],
    rawEventTypes: Array.isArray(action.raw?.eventTypes) ? [...action.raw.eventTypes] : [],
    ...(cleanText(action.raw?.unclassifiedReason)
      ? { unclassifiedReason: cleanText(action.raw.unclassifiedReason) }
      : {}),
    ...(action.enumOptions ? { enumOptions: action.enumOptions } : {}),
  };
}

function scalarValue(value: string | string[] | null | undefined): string | undefined {
  if (Array.isArray(value)) return value.length === 1 ? value[0] : JSON.stringify(value);
  return value ?? undefined;
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sanitizeSemanticTarget(target: SemanticTarget | undefined): SemanticTarget | undefined {
  if (!target || typeof target !== 'object') return undefined;
  return {
    ...target,
    ...(typeof target.accessibleName === 'string' ? {} : { accessibleName: undefined }),
    ...(typeof target.name === 'string' ? {} : { name: undefined }),
    ...(typeof target.placeholder === 'string' ? {} : { placeholder: undefined }),
  };
}
