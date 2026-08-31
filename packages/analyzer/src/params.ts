import { IDENTIFIER_STABILITY } from '@dsh/core';
import type { InternalValueDefinition, ParamDefinition } from '@dsh/core';
import type { RecordSession } from '@dsh/core';

import { analysisSession, type AnalyzedAction, type AnalysisSession } from './action-view.js';
import { inferActionLineages } from './lineage.js';

const DATE_VALUE = /^\d{4}-\d{2}-\d{2}/;

export interface ParamCandidate {
  definition: ParamDefinition;
  confidence: number;
  sources: string[];
  sourceIndexes: number[];
  enumStatus?: 'static' | 'contextual' | 'incomplete';
  enumSignature?: string;
  internal?: boolean;
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
  return detectCanonicalParams(session, secondSession)
    .filter((candidate) => !candidate.internal);
}

export function detectInternalValues(session: RecordSession): InternalValueDefinition[] {
  return detectCanonicalParams(session)
    .filter((candidate) => candidate.internal)
    .map((candidate) => ({
      name: candidate.definition.name,
      type: candidate.definition.type,
      lineage: candidate.definition.lineage!,
      carrier: candidate.definition.carrier!,
    }));
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

function detectCanonicalParams(
  session: RecordSession,
  secondSession?: RecordSession,
): ParamCandidate[] {
  const actions = session.canonicalActions;
  const inferred = inferActionLineages(session);
  const candidates: ParamCandidate[] = [];
  for (const request of session.network) {
    let url: URL;
    try { url = new URL(request.url); } catch { continue; }
    for (const [field, wireValue] of url.searchParams) {
      const owner = actions.find((action) =>
        action.actionIdx === request.actionIdx
        && ['edit', 'select', 'check'].includes(action.kind)
        && directEvidenceValues(action).includes(wireValue),
      );
      if (!owner) continue;
      if (candidates.some((candidate) => candidate.sourceIndexes.length === 1
        && candidate.sourceIndexes[0] === owner.actionIdx)) continue;
      const source = inferred.find((item) => item.actionIndexes.includes(owner.actionIdx));
      const semanticName = normalizeIdentifier(
        owner.target?.accessibleName ?? owner.target?.neighborhood?.labelText,
      );
      const name = uniqueParamName(
        owner.target?.name ?? semanticName ?? field,
        candidates.map((candidate) => candidate.definition.name),
      );
      candidates.push({
        definition: {
          name,
          type: DATE_VALUE.test(wireValue) ? 'datetime' : 'string',
          required: true,
          ...(owner.target?.accessibleName ? { prompt: owner.target.accessibleName } : {}),
          lineage: source?.lineage ?? {
            source: { kind: 'user-input', actionIdx: owner.actionIdx },
            representation: { wire: 'string', hasDisplayValue: false },
            cardinality: 'single',
            identity: {
              controlKey: owner.target?.name ? `name:${owner.target.name}` : `action:${owner.actionIdx}`,
              displayName: owner.target?.accessibleName ?? owner.target?.name ?? field,
            },
          },
          carrier: { via: 'network-url', requestStepId: request.requestId },
        },
        confidence: 1,
        sources: [`action[${owner.actionIdx}]`],
        sourceIndexes: [owner.actionIdx],
      });
    }
  }
  for (const request of session.network.filter((item) => item.mutating && item.postData)) {
    let body: unknown;
    try { body = JSON.parse(request.postData!); } catch { continue; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    const entries = Object.entries(body);
    const interactive = actions.filter((action) =>
      ['edit', 'select', 'check', 'upload'].includes(action.kind)
      || (action.kind === 'activate' && (
        action.target?.role !== 'button' || (action.effects?.domMutations?.length ?? 0) > 0
      )),
    );
    for (const [field, wireValue] of entries) {
      const wireLeaves = primitiveValues(wireValue);
      let owners = interactive.filter((action) =>
        evidenceValues(action).some((value) => wireLeaves.includes(value))
        || responseAliasMatches(session, action, wireLeaves),
      );
      let usedSingleFieldFallback = false;
      if (owners.length === 0 && entries.length === 1 && interactive.length > 0) {
        owners = interactive;
        usedSingleFieldFallback = true;
      }
      if (owners.length === 0) continue;
      if (usedSingleFieldFallback && responseContainsWire(session, wireLeaves)) continue;
      const actionIndexes = [...new Set(owners.map((action) => action.actionIdx))];
      const sameSource = candidates.find((candidate) =>
        candidate.definition.name === field
        && actionIndexes.length === 1
        && candidate.sourceIndexes.length === actionIndexes.length
        && candidate.sourceIndexes.every((index) => actionIndexes.includes(index)),
      );
      if (sameSource) continue;
      const derivedEffects = owners.flatMap((action) => {
        if (directEvidenceValues(action).some((value) => wireLeaves.includes(value))) return [];
        if (responseAliasMatches(session, action, wireLeaves)) return [];
        return (action.effects?.domMutations ?? [])
          .filter((effect) => primitiveValues(effect.after).some((value) => wireLeaves.includes(value)))
          .map((effect) => ({ action, effect }));
      });
      const derived = derivedEffects.length > 0
        && new Set(derivedEffects.map(({ action }) => action.actionIdx)).size === owners.length;
      const pageDerived = derived && derivedEffects.every(
        ({ effect }) => !effect.after || !('value' in effect.after),
      );
      const source = inferred.find((item) => item.actionIndexes.some((index) => actionIndexes.includes(index)));
      const sourceActionIdx = source?.lineage.source.kind === 'user-input'
        ? source.lineage.source.actionIdx
        : undefined;
      const first = owners.find((action) => action.actionIdx === sourceActionIdx) ?? owners[0]!;
      const domEvidence = canonicalDomEnumEvidence(session, first, secondSession);
      const responseOptions = domEvidence.status === 'contextual'
        ? undefined
        : domEvidence.values ?? owners
          .map((action) => canonicalResponseOptions(session, action))
          .find((options) => options.some((option) => wireLeaves.includes(option.value)));
      const hasResponseAlias = owners.some((action) => responseAliasMatches(session, action, wireLeaves));
      const hasDirectWireEvidence = owners.some((action) =>
        directEvidenceValues(action).some((value) => wireLeaves.includes(value)),
      );
      const hasChoiceAction = owners.some((action) => action.kind === 'select' || action.kind === 'check');
      if (hasResponseAlias && !hasDirectWireEvidence && !responseOptions && !hasChoiceAction) {
        // A search/edit can identify a response row without making that row's
        // returned identifier a caller parameter. Leave it to cross-request
        // dependency extraction unless an explicit choice action/domain proves it.
        continue;
      }
      const representation = responseOptions ? {
        wire: 'enum' as const,
        hasDisplayValue: true,
        enumDomain: {
          map: enumMap(responseOptions), contextual: false,
          origin: domEvidence.values ? 'dom-options' as const : 'response' as const,
          complete: true,
        },
      } : source?.lineage.representation ?? {
        wire: wireRepresentation(wireValue), hasDisplayValue: false,
      };
      const cardinality = Array.isArray(wireValue) ? 'multiple' as const : 'single' as const;
      const sourceName = pageDerived || cardinality === 'multiple' || responseOptions || hasResponseAlias
        ? field
        : first.target?.name ?? field;
      const name = uniqueParamName(sourceName, candidates.map((item) => item.definition.name));
      const type: ParamDefinition['type'] = responseOptions ? 'enum'
        : Array.isArray(wireValue) || isPlainObject(wireValue)
        ? 'json'
        : typeof wireValue === 'number' ? 'number'
          : typeof wireValue === 'boolean' ? 'boolean'
            : DATE_VALUE.test(String(wireValue)) ? 'datetime' : 'string';
      candidates.push({
        definition: {
          name, type, required: !pageDerived,
          ...(responseOptions ? { values: responseOptions, enumMap: enumMap(responseOptions) } : {}),
          ...(!pageDerived && (first.target?.accessibleName || first.target?.neighborhood?.labelText)
            ? { prompt: first.target?.accessibleName ?? first.target?.neighborhood?.labelText }
            : {}),
          lineage: {
            source: pageDerived
              ? { kind: 'derived', dependsOn: actionIndexes.map((index) => `action:${index}`) }
              : source?.lineage.source ?? { kind: 'user-input', actionIdx: first.actionIdx },
            representation: {
              ...representation,
              wire: responseOptions ? 'enum' : wireRepresentation(wireValue),
            },
            cardinality,
            identity: {
              controlKey: pageDerived
                ? `locator:${JSON.stringify(derivedEffects[0]!.effect.locator)}`
                : source?.lineage.identity.controlKey
                ?? (first.target?.name ? `name:${first.target.name}` : `action:${first.actionIdx}`),
              displayName: pageDerived ? field : first.target?.accessibleName
                ?? first.target?.neighborhood?.labelText ?? first.target?.name ?? field,
              ...(source?.lineage.identity.groupKey ? { groupKey: source.lineage.identity.groupKey } : {}),
            },
          },
          carrier: pageDerived
            ? { via: 'page-derived', targetLocator: derivedEffects[0]!.effect.locator }
            : { via: 'network-body', requestStepId: request.requestId },
        },
        confidence: 1,
        sources: actionIndexes.map((index) => `action[${index}]`),
        sourceIndexes: actionIndexes,
        ...(domEvidence.status ? {
          enumStatus: domEvidence.status,
          ...(domEvidence.signature ? { enumSignature: domEvidence.signature } : {}),
        } : {}),
        ...(pageDerived ? { internal: true } : {}),
      });
    }
  }
  for (const action of actions.filter((item) => item.kind === 'upload')) {
    const field = action.target?.name ?? normalizeIdentifier(
      action.target?.accessibleName ?? action.target?.neighborhood?.labelText,
    ) ?? `upload_${action.actionIdx + 1}`;
    const files = action.after?.self?.files ?? [];
    candidates.push({
      definition: {
        name: uniqueParamName(field, candidates.map((item) => item.definition.name)),
        type: 'file', required: true,
        ...(action.target?.accessibleName ? { prompt: action.target.accessibleName } : {}),
        lineage: {
          source: { kind: 'user-input', actionIdx: action.actionIdx },
          representation: { wire: 'file', hasDisplayValue: false },
          cardinality: files.length > 1 ? 'multiple' : 'single',
          identity: {
            controlKey: action.target?.name ? `name:${action.target.name}` : `action:${action.actionIdx}`,
            displayName: action.target?.accessibleName ?? field,
          },
        },
        carrier: {
          via: 'ui-upload',
          ...(action.target?.locatorEvidence ? {
            targetLocator: {
              strategy: 'playwright', selector: action.target.locatorEvidence.generatedSelector,
              confidence: action.target.locatorEvidence.confidence,
            },
          } : {}),
        },
      },
      confidence: 1, sources: [`action[${action.actionIdx}]`], sourceIndexes: [action.actionIdx],
    });
  }
  return candidates;
}

function canonicalDomEnumEvidence(
  session: RecordSession,
  action: RecordSession['canonicalActions'][number],
  secondSession?: RecordSession,
): {
  status?: 'static' | 'contextual' | 'incomplete';
  values?: Array<{ label: string; value: string }>;
  signature?: string;
} {
  const first = action.enumOptions;
  if (!first) return {};
  if (!first.complete || first.items.length === 0) return { status: 'incomplete' };
  const signature = optionSignature(first.items);
  if (!secondSession) return { status: 'incomplete', signature };
  const target = JSON.stringify(action.target?.locatorEvidence ?? action.target);
  const peer = secondSession.canonicalActions.find((candidate) =>
    candidate.kind === action.kind
    && JSON.stringify(candidate.target?.locatorEvidence ?? candidate.target) === target,
  );
  if (!peer?.enumOptions?.complete || peer.enumOptions.items.length === 0) {
    return { status: 'incomplete', signature };
  }
  if (optionSignature(peer.enumOptions.items) !== signature) {
    return { status: 'contextual', signature };
  }
  if (!recordingsVary(analysisSession(session), analysisSession(secondSession))) {
    return { status: 'incomplete', signature };
  }
  return { status: 'static', values: mergeEnumValues([], first.items), signature };
}

function primitiveValues(value: unknown): string[] {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(primitiveValues);
  if (isPlainObject(value)) return Object.values(value).flatMap(primitiveValues);
  return [];
}

function evidenceValues(action: NonNullable<RecordSession['canonicalActions']>[number]): string[] {
  const states = [action.before?.self, action.after?.self,
    ...(action.effects?.domMutations ?? []).flatMap((effect) => [effect.before, effect.after])];
  return [...new Set([
    ...states.flatMap((state) => primitiveValues(state?.value)),
    ...states.flatMap((state) => primitiveValues(state?.checked)),
    ...states.flatMap((state) => primitiveValues(state?.aria?.checked)),
    ...states.flatMap((state) => primitiveValues(state?.innerHTML)),
    ...states.flatMap((state) => primitiveValues(state?.textContent)),
    ...primitiveValues(action.target?.accessibleName),
    ...primitiveValues(action.target?.neighborhood?.labelText),
  ])];
}

function directEvidenceValues(
  action: NonNullable<RecordSession['canonicalActions']>[number],
): string[] {
  const states = [action.before?.self, action.after?.self];
  return [...new Set([
    ...states.flatMap((state) => primitiveValues(state)),
    ...primitiveValues(action.target?.accessibleName),
    ...primitiveValues(action.target?.neighborhood?.labelText),
  ])];
}

function responseAliasMatches(session: RecordSession, action: NonNullable<RecordSession['canonicalActions']>[number], wire: string[]): boolean {
  if (canonicalResponseOptions(session, action).some((option) => wire.includes(option.value))) return true;
  const evidence = new Set(evidenceValues(action));
  let matched = false;
  for (const request of session.network) {
    if (!request.responseBody) continue;
    let body: unknown;
    try { body = JSON.parse(request.responseBody); } catch { continue; }
    const records = Array.isArray(body) ? body : isPlainObject(body)
      ? Object.values(body).filter(Array.isArray).flat() : [];
    const evidenceRecords = records.filter((record) =>
      isPlainObject(record) && primitiveValues(record).some((value) => evidence.has(value)),
    );
    if (evidenceRecords.length === 0) continue;
    if (evidenceRecords.length !== 1) return false;
    if (!primitiveValues(evidenceRecords[0]).some((value) => wire.includes(value))) return false;
    matched = true;
  }
  return matched;
}

function responseContainsWire(session: RecordSession, wire: string[]): boolean {
  return session.network.some((request) => {
    if (!request.responseBody) return false;
    try {
      const parsed: unknown = JSON.parse(request.responseBody);
      const values = primitiveValues(parsed);
      return wire.every((value) => values.includes(value));
    } catch {
      return false;
    }
  });
}

function canonicalResponseOptions(
  session: RecordSession,
  action: NonNullable<RecordSession['canonicalActions']>[number],
): Array<{ label: string; value: string }> {
  const labels = canonicalOptionLabels(action);
  if (labels.length === 0 || action.after?.affectedTruncated !== false) return [];
  const candidates: Array<Array<{ label: string; value: string }>> = [];
  for (const request of session.network) {
    if (!request.responseBody || requestHasVariableContext(request, analysisSession(session).actions)) continue;
    try {
      const body: unknown = JSON.parse(request.responseBody);
      if (!Array.isArray(body)) continue;
      const options = inferScalarPairs(body, labels[0]!);
      const optionLabels = new Set(options.map((option) => option.label));
      if (optionLabels.size === options.length && labels.every((label) => optionLabels.has(label))) {
        candidates.push(options);
      }
    } catch {
      continue;
    }
  }
  if (candidates.length !== 1) return [];
  return candidates[0]!;
}

function canonicalOptionLabels(
  action: NonNullable<RecordSession['canonicalActions']>[number],
): string[] {
  const labels = (action.after?.affected ?? []).flatMap(({ locator, state }) => {
    if (locator.strategy !== 'playwright') return [];
    const role = /^internal:role=option\[name="([\s\S]*)"i\]$/.exec(locator.selector)?.[1];
    const label = state.textContent?.trim() || role?.replaceAll('\\"', '"').trim();
    return label ? [label] : [];
  });
  return [...new Set(labels)];
}

function wireRepresentation(value: unknown): NonNullable<ParamDefinition['lineage']>['representation']['wire'] {
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value) || isPlainObject(value)) return 'json';
  return 'string';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueParamName(base: string, used: string[]): string {
  if (!used.includes(base)) return base;
  let suffix = 2;
  while (used.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
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
