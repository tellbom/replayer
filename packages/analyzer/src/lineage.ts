import type { CanonicalAction, RecordSession, ValueLineage } from '@dsh/core';

export interface InferredActionLineage {
  actionIndexes: number[];
  recordedValue: unknown;
  displayName?: string;
  lineage: ValueLineage;
}

/** Infer value identity from action provenance and standard DOM semantics only. */
export function inferActionLineages(session: RecordSession): InferredActionLineage[] {
  const actions = session.canonicalActions ?? [];
  const consumed = new Set<number>();
  const output: InferredActionLineage[] = [];

  for (const action of actions) {
    if (consumed.has(action.actionIdx) || !isValueAction(action)) continue;
    if (isNamedCheckbox(action)) {
      const peers = actions.filter((candidate) =>
        isNamedCheckbox(candidate) && candidate.target?.name === action.target?.name,
      );
      if (peers.length > 1) {
        peers.forEach((peer) => consumed.add(peer.actionIdx));
        const selected = peers.filter((peer) => checked(peer)).map((peer) => scalarValue(peer));
        output.push({
          actionIndexes: peers.map((peer) => peer.actionIdx),
          recordedValue: selected,
          displayName: action.target?.name,
          lineage: {
            source: { kind: 'user-input', actionIdx: action.actionIdx },
            representation: {
              wire: 'enum', hasDisplayValue: true,
              enumDomain: {
                map: Object.fromEntries(peers.map((peer) => [displayName(peer), String(scalarValue(peer))])),
                contextual: false, origin: 'recorded-only', complete: false,
              },
            },
            cardinality: 'multiple',
            identity: {
              controlKey: `name:${action.target!.name!}`,
              displayName: action.target!.name!,
              groupKey: `name:${action.target!.name!}`,
            },
          },
        });
        continue;
      }
    }
    consumed.add(action.actionIdx);
    const value = actionValue(action);
    const checkboxValue = action.kind === 'check' ? scalarValue(action) : undefined;
    const booleanCheckbox = action.kind === 'check' && (!checkboxValue || checkboxValue === 'on');
    output.push({
      actionIndexes: [action.actionIdx],
      recordedValue: booleanCheckbox ? checked(action) : value,
      displayName: displayName(action),
      lineage: {
        source: { kind: 'user-input', actionIdx: action.actionIdx },
        representation: {
          wire: booleanCheckbox ? 'boolean' : wireType(action, value),
          hasDisplayValue: Boolean(action.after?.self?.textContent),
          ...(!booleanCheckbox && action.kind === 'check' ? {
            enumDomain: {
              map: { [displayName(action)]: String(checkboxValue) },
              contextual: false, origin: 'recorded-only' as const, complete: false,
            },
          } : {}),
        },
        cardinality: Array.isArray(value) ? 'multiple' : 'single',
        identity: {
          controlKey: controlKey(action),
          displayName: displayName(action),
        },
      },
    });
  }
  return output;
}

function isValueAction(action: CanonicalAction): boolean {
  return ['edit', 'select', 'check', 'upload'].includes(action.kind);
}

function isNamedCheckbox(action: CanonicalAction): boolean {
  return action.kind === 'check' && action.target?.inputType === 'checkbox' && Boolean(action.target.name);
}

function checked(action: CanonicalAction): boolean {
  return action.after?.self?.checked ?? action.after?.self?.aria?.checked === 'true';
}

function scalarValue(action: CanonicalAction): string {
  const value = action.after?.self?.value;
  return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
}

function actionValue(action: CanonicalAction): unknown {
  const state = action.after?.self;
  if (action.kind === 'upload') return state?.files?.map((file) => file.name) ?? [];
  if (state?.value !== undefined && state.value !== null) return state.value;
  if (state?.innerHTML !== undefined) return state.innerHTML;
  if (state?.checked !== undefined) return state.checked;
  if (state?.aria?.checked !== undefined) return state.aria.checked === 'true';
  return state?.textContent;
}

function wireType(action: CanonicalAction, value: unknown): ValueLineage['representation']['wire'] {
  if (action.kind === 'upload') return 'file';
  if (action.kind === 'select' || action.kind === 'check') return 'enum';
  if (typeof value === 'number' || action.target?.inputType === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) return 'json';
  return 'string';
}

function controlKey(action: CanonicalAction): string {
  if (action.target?.name) return `name:${action.target.name}`;
  if (action.target?.locatorEvidence?.generatedSelector) {
    return `locator:${action.target.locatorEvidence.generatedSelector}`;
  }
  return `action:${action.actionIdx}`;
}

function displayName(action: CanonicalAction): string {
  return action.target?.accessibleName
    || action.target?.neighborhood?.labelText
    || action.target?.placeholder
    || action.target?.name
    || `action_${action.actionIdx + 1}`;
}
