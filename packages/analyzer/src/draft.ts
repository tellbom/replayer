import { SkillSchema, UnusedParameterError } from '@dsh/core';
import type { RecordedRequest, RecordSession, Skill } from '@dsh/core';
import { Document, isMap, isNode, isSeq } from 'yaml';

import { correlate, type CorrelatedRequest } from './correlate.js';
import { analysisSession, analyzedInputs, type AnalyzedAction } from './action-view.js';
import { assertPlannedCarriers } from './channel-planner.js';
import { analyzeIdentifierStability, detectInternalValues, detectParams } from './params.js';
import { detectPreflight } from './preflight.js';

interface DraftItem {
  id: string;
  action: AnalyzedAction | null;
  request: CorrelatedRequest | null;
  hasSideEffect: boolean;
  afterSessionInterrupt: boolean;
  sourceActionIndex: number;
  expectsRedirect: boolean;
}

interface PageScopedAnalysis {
  bodyBindings: ReadonlyMap<string, string>;
  extractsByAction: ReadonlyMap<number, Record<string, string>>;
}

export interface DraftResult {
  skill: Skill;
  yaml: string;
}

type ParamBindings = ReadonlyMap<number, Skill['params'][number]>;

/** Collapse progressive input requests using browser-observed causality, never endpoint names. */
export function collapseIntermediateRequests(
  requests: RecordedRequest[],
): RecordedRequest[] {
  const groups = new Map<string, Array<{ request: RecordedRequest; value: string }>>();
  for (const request of requests) {
    if (request.mutating || request.actionIdx === null || request.actionIdx === undefined) continue;
    if (request.causality !== 'active-action' || request.causalityDebug?.kind !== 'input') continue;
    const value = request.causalityDebug.valueAtRequest;
    if (value === null) continue;
    let parsed: URL;
    try {
      parsed = new URL(request.url, 'http://dsh.invalid');
    } catch {
      continue;
    }
    const matchingKeys = [...parsed.searchParams.entries()]
      .filter(([, candidate]) => candidate === value)
      .map(([key]) => key);
    if (matchingKeys.length !== 1) continue;
    const activeKey = matchingKeys[0]!;
    const shape = [...parsed.searchParams.entries()]
      .map(([key, candidate]) => [key, key === activeKey ? '<ACTIVE_VALUE>' : candidate] as const)
      .sort((left, right) => left[0].localeCompare(right[0]));
    const groupKey = JSON.stringify([
      request.actionIdx,
      request.method,
      parsed.origin,
      parsed.pathname,
      shape,
    ]);
    const group = groups.get(groupKey) ?? [];
    group.push({ request, value });
    groups.set(groupKey, group);
  }

  const discarded = new Set<RecordedRequest>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => left.request.requestTs - right.request.requestTs);
    const progressive = ordered.every((item, index) =>
      index === 0 || (item.value.length >= ordered[index - 1]!.value.length
        && item.value.includes(ordered[index - 1]!.value)),
    );
    if (!progressive) continue;
    ordered.slice(0, -1).forEach((item) => discarded.add(item.request));
  }
  return requests.filter((request) => !discarded.has(request));
}

/** 将一次录制转为可校验、待人工复核的技能草稿。 */
export function generateDraft(session: RecordSession, secondSession?: RecordSession): DraftResult {
  assertRecordSession(session);
  const collapsedSession = { ...session, network: collapseIntermediateRequests(session.network) };
  const correlated = correlate(collapsedSession);
  const identifierStability = analyzeIdentifierStability(session, secondSession);
  const paramCandidates = detectParams(session, secondSession);
  const analyzed = analysisSession(session).actions;
  for (const candidate of paramCandidates) {
    const index = candidate.sourceIndexes.length === 1 ? candidate.sourceIndexes[0] : undefined;
    if (index === undefined || !identifierStability.confirmed.has(index)) continue;
    const action = analyzed.find((item) => item.actionIdx === index);
    const semanticName = normalizeVariableName(action?.label ?? action?.semanticTarget?.accessibleName);
    if (!semanticName) continue;
    const used = paramCandidates
      .filter((item) => item !== candidate)
      .map((item) => item.definition.name);
    candidate.definition.name = uniqueVariableName(semanticName, used);
  }
  const params = paramCandidates.map((candidate) => candidate.definition);
  const internalValues = detectInternalValues(session);
  const planningParams: Skill['params'] = [
    ...params,
    ...internalValues.map((value) => ({ ...value, required: false })),
  ];
  const paramBindings = new Map<number, Skill['params'][number]>();
  for (const candidate of paramCandidates) {
    if (candidate.sourceIndexes.length !== 1) continue;
    candidate.sourceIndexes.forEach((index) => {
      // A direct interaction binding is discovered before response-derived wire
      // fields. Keep it as the action's caller-facing parameter; later fields are
      // still parameterized by their explicit network-body carrier.
      if (!paramBindings.has(index)) paramBindings.set(index, candidate.definition);
    });
  }
  const enumEvidenceNotes = paramCandidates.flatMap((candidate) => {
    if (candidate.enumStatus === 'contextual') {
      return [`参数 ${candidate.definition.name} 的选项集合随上下文变化，禁止静态固化 enumMap。`];
    }
    if (candidate.enumStatus === 'incomplete') {
      return [`参数 ${candidate.definition.name} 仅保留录制值；完整静态选项集合尚未得到证明。`];
    }
    return [];
  });
  const items: DraftItem[] = [];
  const interruptionIndexes = new Set(session.interruptions?.map((item) => item.atActionIdx) ?? []);
  for (const step of correlated) {
    const recordedAction = step.action;
    const actionIndex = recordedAction?.actionIdx ?? -1;
    const action = recordedAction
      ? withIdentifierConfidence(recordedAction, actionIndex, identifierStability)
      : null;
    const afterSessionInterrupt = interruptionIndexes.has(actionIndex);
    if (step.requests.length === 0 && action) {
      items.push({
        id: '',
        action,
        request: null,
        hasSideEffect: false,
        afterSessionInterrupt,
        sourceActionIndex: actionIndex,
        expectsRedirect: false,
      });
      continue;
    }
    step.requests.forEach((request, index) => {
      items.push({
        id: '',
        action: index === 0 ? action : null,
        request,
        hasSideEffect: request.mutating,
        afterSessionInterrupt: index === 0 && afterSessionInterrupt,
        sourceActionIndex: actionIndex,
        expectsRedirect: isRedirectingSubmission(session, request),
      });
    });
  }
  items.forEach((item, index) => {
    item.id = `s${index + 1}`;
  });
  const stepByRequest = new Map(
    items
      .filter((item): item is DraftItem & { request: CorrelatedRequest } => item.request !== null)
      .map((item) => [item.request.requestId, item.id]),
  );
  const stepByActionIndex = new Map<number, string>();
  for (const item of items) {
    if (item.sourceActionIndex >= 0 && !stepByActionIndex.has(item.sourceActionIndex)) {
      stepByActionIndex.set(item.sourceActionIndex, item.id);
    }
  }
  const recordedInputs = analyzedInputs(session);
  const pageScoped = pageScopedAnalysis(session, planningParams.map((param) => param.name));
  const extracts = dependencyExtracts(items, params, recordedInputs, paramBindings);
  const preflight = detectPreflight(collapsedSession);
  const steps: Skill['steps'] = items.map(
    (item) =>
      draftStep(
        item,
        planningParams,
        stepByRequest,
        extracts,
        session.meta.baseUrl,
        stepByActionIndex,
        recordedInputs,
        paramBindings,
        pageScoped,
      ) as Skill['steps'][number],
  );
  for (const param of params) {
    const requestId = param.carrier?.requestStepId;
    const stepId = requestId ? stepByRequest.get(requestId) : undefined;
    if (stepId && param.carrier) param.carrier = { ...param.carrier, requestStepId: stepId };
  }
  const usedParams = params.filter((param) => steps.some((step) => [
    step.network?.url, step.network?.headers, step.network?.body, step.ui?.value,
  ].some((value) => containsParameterTemplate(value, param.name))));
  assertPlannedCarriers(usedParams);
  const unusedParamNotes = params
    .filter((param) => !usedParams.includes(param))
    .map((param) => `参数 ${param.name} 无可靠引用，已从 draft 参数声明中移除。`);
  const provenanceNotes = guardMutatingBodyLiterals(
    steps,
    new Set(preflight.map((item) => item.name)),
  );
  const postcondition = inferPostcondition(items, usedParams, session.meta.baseUrl);
  // 【C16】技能不含 auth 段：认证载体在 entries/<id>.yaml，录制时由 record 记录 entryId。
  const raw = {
    skill: {
      id: skillId(items),
      name: '录制技能草稿',
      description: '根据浏览器录制自动生成，发布前需复核 TODO',
      system: new URL(session.meta.baseUrl).hostname,
      baseUrl: session.meta.baseUrl,
      entry: session.meta.entryId,
      version: 1,
      recordedAt: session.meta.endedAt,
    },
    params: usedParams,
    internalValues,
    preflight,
    steps,
    assertions: steps.some((step) => step.expectsRedirect)
      ? []
      : [{ type: 'httpStatus', expect: 200 }],
    verification: {
      status: 'draft',
      requiresFirstRunVerification: steps.some(
        (step) => (
          step.ui?.target?.strategy === 'playwright'
          || step.ui?.target?.strategy === 'frame-playwright'
        ) && step.ui.target.confidence === 'LOW',
      ),
      verifiedTtlDays: steps.some((step) => {
        const hint = step.ui?.recordedHint;
        return (
          step.ui?.target?.strategy === 'playwright'
          || step.ui?.target?.strategy === 'frame-playwright'
        )
          && step.ui.target.confidence === 'LOW'
          && (!hint || (hint.controlSemantics === null && hint.visibleText === null));
      }) ? 7 : 30,
    },
    ...(postcondition ? { postcondition } : {}),
    ...(reentryDraft(steps) ? { reentry: reentryDraft(steps) } : {}),
    _notes: [
      '动作与请求仅按 requestTs 关联。',
      '参数来自用户 fill/select/datetime 动作。',
      '跨请求依赖来自结构化脱敏后的叶子值匹配。',
      '所有 TODO 项必须在发布前人工确认。',
      '认证载体见 entries/ 目录（C16：技能不含登录环节）。',
      '若未生成 reentry：首步即写时无幂等 anchor 可用，请人工前移幂等步骤（C22）。',
      ...businessHeaderNotes(steps),
      ...provenanceNotes,
      ...sessionInterruptNotes(items, session),
      ...identifierStabilityNotes(identifierStability),
      ...unrecognizedActionNotes(items),
      ...unusedParamNotes,
      ...enumEvidenceNotes,
    ],
  };
  const skill = SkillSchema.parse(raw);
  assertNoIndexedResponseTemplates(skill);
  return { skill, yaml: renderDraftYaml(skill, Boolean(postcondition)) };
}

export function assertParametersUsed(skill: Skill): void {
  for (const param of skill.params) {
    const used = skill.steps.some((step) => {
      const targets = [step.network?.url, step.network?.headers, step.network?.body, step.ui?.value];
      return targets.some((target) => containsParameterTemplate(target, param.name));
    });
    if (used) continue;
    const candidates = skill.steps
      .filter((step) => step.ui?.label === param.prompt || bodyContainsKey(step.network?.body, param.name))
      .map((step) => step.id);
    throw new UnusedParameterError(
      `参数 '${param.name}' 已声明但未被任何步骤引用。` +
        '这通常意味着参数化失败——该值可能被硬编码或从响应中取值。' +
        `请检查步骤 ${candidates.length > 0 ? candidates.join('、') : '中与该参数对应的 body/ui.value'}。`,
    );
  }
}

function assertRecordSession(session: RecordSession): void {
  if (!session || typeof session !== 'object' || !session.meta
    || !Array.isArray(session.canonicalActions) || !Array.isArray(session.network)
    || !Array.isArray(session.pages)) {
    throw new TypeError('input is not a RecordSession');
  }
  new URL(session.meta.baseUrl);
}

function withIdentifierConfidence(
  action: AnalyzedAction,
  index: number,
  stability: ReturnType<typeof analyzeIdentifierStability>,
): AnalyzedAction {
  if (!stability.confirmed.has(index) && !stability.suspected.has(index)) return action;
  if (action.locator?.strategy !== 'playwright' && action.locator?.strategy !== 'frame-playwright') {
    return action;
  }
  return { ...action, locator: { ...action.locator, confidence: 'LOW' } };
}

function identifierStabilityNotes(
  stability: ReturnType<typeof analyzeIdentifierStability>,
): string[] {
  return [
    ...[...stability.confirmed].map((index) =>
      `动作 ${index} 的 DOM 标识在两份录制间发生变化，已确认不稳定并降低定位置信度。`,
    ),
    ...[...stability.suspected]
      .filter((index) => !stability.confirmed.has(index))
      .map((index) =>
        `动作 ${index} 的 DOM 标识含高熵片段，仅标记为疑似不稳定并降低定位置信度。`,
      ),
  ];
}

function unrecognizedActionNotes(items: DraftItem[]): string[] {
  return items.flatMap((item) => {
    const action = item.action;
    if (!action || action.kind === 'navigate') return [];
    const visible = action.label ?? action.text ?? action.semanticTarget?.accessibleName;
    return visible?.trim()
      ? []
      : [`步骤 ${item.id} 无可识别文本，无法可靠标注语义；若涉及可变输入请人工补充。`];
  });
}

function containsParameterTemplate(value: unknown, name: string): boolean {
  if (typeof value === 'string') {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\{\\{\\s*${escaped}(?:\\s*\\||\\s*\\}|[.[])`).test(value);
  }
  if (Array.isArray(value)) return value.some((item) => containsParameterTemplate(item, name));
  if (typeof value !== 'object' || value === null) return false;
  return Object.values(value).some((item) => containsParameterTemplate(item, name));
}

function bodyContainsKey(value: unknown, key: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).some(
    ([name, child]) => name === key || bodyContainsKey(child, key),
  );
}

function assertNoIndexedResponseTemplates(skill: Skill): void {
  const serialized = JSON.stringify(skill.steps);
  if (/\{\{\s*s\d+[^{}]*\[\d+\]/.test(serialized)) {
    throw new Error('禁止生成包含固定数组下标的响应模板');
  }
}

/** 【C22】reentry 草稿：anchor 取第一个非幂等步骤之前的那一步。 */
function reentryDraft(steps: Skill['steps']): { anchor: string; maxReentries: number } | undefined {
  if (steps.length === 0) return undefined;
  const firstNonIdempotent = steps.findIndex(
    (step) => !(step.idempotent ?? step.riskLevel === 'read'),
  );
  // 全部幂等 → anchor 落在首步（重跑整个前缀安全）
  if (firstNonIdempotent === -1) return { anchor: steps[0]!.id, maxReentries: 2 };
  // 首步即写 → 无前置幂等步骤可作 anchor，生成 reentry 只会让 C22 校验拒绝。
  // 不生成，由 YAML 注释说明（见 _notes），人工须前移幂等步骤或显式声明幂等。
  if (firstNonIdempotent === 0) return undefined;
  return { anchor: steps[firstNonIdempotent - 1]!.id, maxReentries: 2 };
}

function draftStep(
  item: DraftItem,
  params: Skill['params'],
  stepByRequest: Map<string, string>,
  extracts: Map<string, Record<string, string>>,
  baseUrl: string,
  stepByActionIndex: Map<number, string>,
  recordedInputs: AnalyzedAction[],
  paramBindings: ParamBindings,
  pageScoped: PageScopedAnalysis,
): unknown {
  const request = item.request;
  const browserMultipart = Boolean(
    request
    && /multipart\/form-data/i.test(request.headers['content-type'] ?? '')
    && params.some((param) => param.carrier?.via === 'ui-upload'),
  );
  const networkPrimary = params.some((param) => param.carrier?.via.startsWith('network-'));
  const suppressNonPrimaryUi = networkPrimary
    && item.action?.kind !== 'navigate'
    && !request?.mutating;
  const ui = item.action && !suppressNonPrimaryUi
    ? uiAction(
        item.action,
        paramBindings.get(item.sourceActionIndex),
        pageScoped.extractsByAction.get(item.sourceActionIndex),
      )
    : undefined;
  const network = request && !browserMultipart
    ? networkAction(
        request, params, stepByRequest, extracts.get(request.requestId), baseUrl, recordedInputs,
        paramBindings,
        pageScoped.bodyBindings,
      )
    : item.action?.kind === 'navigate'
      ? {
          method: 'GET',
          url: relativeUrl(item.action.url ?? baseUrl, baseUrl),
          contentType: 'json',
        }
      : undefined;
  return {
    id: item.id,
    desc: stepDescription(item),
    channel:
      item.action?.kind === 'navigate'
        ? 'ui'
        : browserMultipart
        ? 'ui'
        : request?.mutating || (request && !ui)
        ? 'network'
        : item.action && !ui
          ? 'merged'
        : item.action?.kind === 'edit'
          ? 'merged'
          : 'ui',
    riskLevel: request?.mutating ? 'write' : 'read',
    hasSideEffect: item.hasSideEffect,
    ...(item.expectsRedirect ? { expectsRedirect: true } : {}),
    ...(network ? { network } : {}),
    ...(ui ? { ui } : {}),
    ...(request?.correlation
      ? {
          _correlation: {
            method: request.correlation.method,
            confidence: request.correlation.confidence,
            ownerAction: stepByActionIndex.get(request.correlation.ownerActionIndex) ?? item.id,
            evidence: request.correlation.evidence,
          },
        }
      : {}),
  };
}

function sessionInterruptNotes(items: DraftItem[], session: RecordSession): string[] {
  if (!session.interruptions?.length) return [];
  const notes = session.interruptions.map((interruption) => {
    const candidate =
      items.find((item) => item.sourceActionIndex === interruption.atActionIdx)?.id ?? '录制末尾';
    return `会话曾在动作 ${interruption.atActionIdx} 后中断；reentry.anchor 候选为 ${candidate}，前后步骤的 scope 关系可能不连续，请人工确认。`;
  });
  if (session.meta.identityChanged) {
    notes.push('录制恢复时身份发生变化，已在断点处中止；不得拼接为同一技能。');
  }
  return notes;
}

function networkAction(
  request: CorrelatedRequest,
  params: Skill['params'],
  stepByRequest: Map<string, string>,
  extract: Record<string, string> | undefined,
  baseUrl: string,
  recordedInputs: AnalyzedAction[],
  paramBindings: ParamBindings,
  pageBindings: PageScopedAnalysis['bodyBindings'],
): unknown {
  const contentType = (request.headers['content-type'] ?? '').includes(
    'application/x-www-form-urlencoded',
  )
    ? 'form'
    : 'json';
  const body = requestBody(request, contentType);
  parameterizeBody(body, params, recordedInputs, paramBindings, pageBindings, request.requestId);
  for (const dependency of request.dependsOn) {
    if (dependency.to.startsWith('header.')) continue;
    if (isTracedTemplate(readBodyPath(body, dependency.to))) continue;
    const dependencyPath = resolvedDependencyPath(dependency, params, recordedInputs, paramBindings);
    if (!dependencyPath) {
      setBodyPath(body, dependency.to, 'TODO_UNRESOLVED');
      continue;
    }
    const sourceStep = stepByRequest.get(dependency.from);
    if (!sourceStep) throw new Error(`依赖源请求未生成步骤: ${dependency.from}`);
    setBodyPath(body, dependency.to, `{{${sourceStep}.${dependencyTargetName(dependency)}}}`);
  }
  const headers = dynamicHeaders(request.headers, request.dependsOn, stepByRequest);
  return {
    method: request.method,
    url: parameterizeUrl(
      request, relativeUrl(request.url, baseUrl), params, recordedInputs, paramBindings,
    ),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    contentType,
    ...(Object.keys(body).length > 0 ? { body } : {}),
    ...(extract && Object.keys(extract).length > 0 ? { extract } : {}),
  };
}

function uiAction(
  action: AnalyzedAction,
  param: Skill['params'][number] | undefined,
  extracts: Record<string, string> | undefined,
): unknown {
  if (param?.carrier && param.carrier.via.startsWith('network-')) return undefined;
  const name = param?.name;
  const value = name ? `{{${name}}}` : action.value;
  const common = {
    ...(action.locator ? { target: action.locator } : {}),
    ...(action.label ? { label: action.label } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(extracts && Object.keys(extracts).length > 0 ? { extract: extracts } : {}),
  };
  if (action.kind === 'select') return { action: 'selectOption', ...common };
  if (action.kind === 'upload') return { action: 'upload', ...common };
  if (action.kind === 'check') {
    return { action: 'check', ...common, checked: action.checked ?? true };
  }
  if (action.kind === 'edit' && /^\d{4}-\d{2}-\d{2}/.test(action.value ?? '')) {
    return { action: 'setDateTime', ...common };
  }
  if (action.kind === 'navigate') return { action: 'navigate', url: action.url, ...common };
  if (action.kind === 'activate') return { action: 'click', ...common };
  if (action.kind === 'edit') return { action: 'fill', ...common };
  if (action.kind === 'key' || action.kind === 'unknown') {
    return action.rawEventTypes.some((event) => event === 'click' || event === 'pointerup')
      ? { action: 'click', ...common }
      : undefined;
  }
  return undefined;
}

function dependencyExtracts(
  items: DraftItem[],
  params: Skill['params'],
  recordedInputs: AnalyzedAction[],
  paramBindings: ParamBindings,
): Map<string, Record<string, string>> {
  const extracts = new Map<string, Record<string, string>>();
  for (const item of items) {
    for (const dependency of item.request?.dependsOn ?? []) {
      const path = resolvedDependencyPath(dependency, params, recordedInputs, paramBindings);
      if (!path) continue;
      const name = dependencyTargetName(dependency);
      const current = extracts.get(dependency.from) ?? {};
      current[name] = path;
      extracts.set(dependency.from, current);
    }
  }
  return extracts;
}

function resolvedDependencyPath(
  dependency: CorrelatedRequest['dependsOn'][number],
  params: Skill['params'],
  recordedInputs: AnalyzedAction[],
  paramBindings: ParamBindings,
): string | undefined {
  if (dependency.ambiguous) return undefined;
  if (!dependency.discriminator) return dependency.path;
  const action = recordedInputs[dependency.discriminator.actionIndex];
  const param = action ? parameterForAction(action, params, recordedInputs, paramBindings) : undefined;
  const indexed = /^(.*)\[\d+\](.*)$/.exec(dependency.path);
  if (!param || !indexed || !/^[A-Za-z_$][\w$]*$/.test(dependency.discriminator.field)) {
    return undefined;
  }
  return `${indexed[1]}[?(@.${dependency.discriminator.field}=="{{${param.name}}}")]${indexed[2]}`;
}

function dependencyTargetName(dependency: CorrelatedRequest['dependsOn'][number]): string {
  if (dependency.to.startsWith('header.')) {
    return `header_${dependency.to.slice('header.'.length).replace(/[^A-Za-z0-9_]/g, '_')}`;
  }
  return dependency.to.split('.').at(-1) ?? 'value';
}

function parameterizeUrl(
  request: CorrelatedRequest,
  url: string,
  params: Skill['params'],
  recordedInputs: AnalyzedAction[],
  paramBindings: ParamBindings,
): string {
  if (request.correlation?.method !== 'action-causality'
    && request.correlation?.method !== 'request-value-match') return url;
  const action = recordedInputs[request.correlation.ownerActionIndex];
  const param = action ? parameterForAction(action, params, recordedInputs, paramBindings) : undefined;
  if (!action || !param || !canRenderParam(param)) return url;
  const candidates = new Set(parameterValues(action, param));
  const matches: Array<{ prefix: string; encoded: string }> = [];
  url.replace(/([?&][^=&#]+=)([^&#]*)/g, (_match, prefix: string, encoded: string) => {
    try {
      const value = decodeURIComponent(encoded.replace(/\+/g, ' '));
      if (candidates.has(value)) matches.push({ prefix, encoded });
    } catch {
      // An undecodable query leaf cannot be proven to come from the action.
    }
    return _match;
  });
  if (matches.length === 0) return url;
  if (matches.length > 1) {
    const ambiguous = new Set(matches.map(({ prefix, encoded }) => `${prefix}\u0000${encoded}`));
    return url.replace(/([?&][^=&#]+=)([^&#]*)/g, (match, prefix: string, encoded: string) => {
      return ambiguous.has(`${prefix}\u0000${encoded}`)
        ? `${prefix}TODO_UNRESOLVED`
        : match;
    });
  }
  const matched = matches[0]!;
  return url.replace(/([?&][^=&#]+=)([^&#]*)/g, (match, prefix: string, encoded: string) => {
    return prefix === matched.prefix && encoded === matched.encoded
      ? `${prefix}{{${param.name}${param.type === 'enum' ? '|enumValue' : ''}}}`
      : match;
  });
}

function parameterValues(
  action: AnalyzedAction,
  param: Skill['params'][number],
): string[] {
  const direct = [action.value, action.text].filter((value): value is string => value !== undefined);
  const aliases = param.values?.flatMap((item) =>
    direct.includes(item.label) || direct.includes(item.value) ? [item.label, item.value] : [],
  ) ?? [];
  return [...new Set([...direct, ...aliases])];
}

function canRenderParam(param: Skill['params'][number]): boolean {
  return param.type !== 'enum' || Boolean(param.enumMap && Object.keys(param.enumMap).length > 0);
}

function parameterForAction(
  action: AnalyzedAction,
  params: Skill['params'],
  recordedInputs: AnalyzedAction[],
  paramBindings: ParamBindings,
): Skill['params'][number] | undefined {
  const index = recordedInputs.indexOf(action);
  return index >= 0 ? paramBindings.get(index) : undefined;
}

function requestBody(
  request: RecordedRequest,
  contentType: 'json' | 'form',
): Record<string, unknown> {
  if (!request.postData) return {};
  try {
    if (contentType === 'form') return Object.fromEntries(new URLSearchParams(request.postData));
    const parsed: unknown = JSON.parse(request.postData);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { unresolvedBody: 'TODO_UNRESOLVED' };
  } catch {
    return { unresolvedBody: 'TODO_UNRESOLVED' };
  }
}

function parameterizeBody(
  body: Record<string, unknown>,
  params: Skill['params'],
  recordedInputs: AnalyzedAction[],
  paramBindings: ParamBindings,
  pageBindings: PageScopedAnalysis['bodyBindings'],
  requestId: string,
): void {
  for (const [key] of Object.entries(body)) {
    const param = params.find((candidate) =>
      candidate.name === key && (
        candidate.carrier?.via === 'page-derived'
        || (candidate.carrier?.via === 'network-body'
          && candidate.carrier.requestStepId === requestId)
      ),
    );
    if (param) body[key] = parameterTemplate(param);
  }
  visitBodyLeaves(body, [], (path, value, replace) => {
    const leafName = path.at(-1);
    const named = leafName ? params.find((candidate) => candidate.name === leafName) : undefined;
    const namedAction = named && recordedInputs.find((action) =>
      parameterForAction(action, params, recordedInputs, paramBindings)?.name === named.name
      && parameterValues(action, named).includes(String(value)),
    );
    const namedMappedValue = named?.values?.some((item) => item.value === String(value)) ?? false;
    if (named && (namedAction || namedMappedValue) && canRenderParam(named)) {
      replace(parameterTemplate(named));
      return;
    }
    if (typeof value !== 'string' && typeof value !== 'number') return;
    const candidates = recordedInputs.flatMap((action) => {
      const param = parameterForAction(action, params, recordedInputs, paramBindings);
      if (!param || !canRenderParam(param)
        || !parameterValues(action, param).includes(String(value))) return [];
      return [param];
    });
    const unique = [...new Map(candidates.map((param) => [param.name, param])).values()];
    if (unique.length === 1) {
      const param = unique[0]!;
      replace(parameterTemplate(param));
      return;
    }
    if (unique.length > 1) return;
    const pageVariable = pageBindings.get(`${requestId}:${path.join('.')}`);
    if (pageVariable) replace(`{{${pageVariable}}}`);
  });
}

function parameterTemplate(param: Skill['params'][number]): string {
  const usesDisplayMapping = param.type === 'enum'
    && (!param.lineage || Boolean(param.lineage.representation.enumDomain));
  return `{{${param.name}${usesDisplayMapping ? '|enumValue' : ''}}}`;
}

function pageScopedAnalysis(session: RecordSession, reservedNames: string[]): PageScopedAnalysis {
  const actions = analysisSession(session).actions;
  const bodyBindings = new Map<string, string>();
  const extractsByAction = new Map<number, Record<string, string>>();
  const variablesBySource = new Map<string, string>();
  const usedNames = [...reservedNames];
  for (const request of session.network.filter((candidate) => candidate.mutating)) {
    const snapshot = [...(session.pageSnapshots ?? [])]
      .filter((candidate) => candidate.ts <= request.requestTs)
      .sort((left, right) => right.ts - left.ts)[0];
    if (!snapshot || snapshot.actionIdx === null) continue;
    const actionIdx = snapshot.actionIdx;
    const navigation = actions[actionIdx];
    if (navigation?.kind !== 'navigate') continue;
    const body = safeObjectBody(request);
    visitBodyLeaves(body, [], (path, value) => {
      if (typeof value !== 'string' && typeof value !== 'number') return;
      const matches = snapshot.immutableValues.filter((candidate) => candidate.value === String(value));
      if (matches.length !== 1) return;
      const match = matches[0]!;
      if (match.locator.strategy !== 'css') return;
      const source = JSON.stringify([snapshot.ts, match.locator]);
      let variable = variablesBySource.get(source);
      if (!variable) {
        const base = normalizeVariableName(path.at(-1)) ?? 'pageValue';
        variable = uniqueVariableName(base, usedNames);
        usedNames.push(variable);
        variablesBySource.set(source, variable);
      }
      bodyBindings.set(`${request.requestId}:${path.join('.')}`, variable);
      const extracts = extractsByAction.get(actionIdx) ?? {};
      extracts[variable] = match.locator.selector;
      extractsByAction.set(actionIdx, extracts);
    });
  }
  return { bodyBindings, extractsByAction };
}

function normalizeVariableName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[^A-Za-z0-9_$]+/g, '_');
  if (!normalized) return undefined;
  return /^[A-Za-z_$]/.test(normalized) ? normalized : `page_${normalized}`;
}

function uniqueVariableName(base: string, used: string[]): string {
  if (!used.includes(base)) return base;
  let suffix = 2;
  while (used.includes(`${base}_${suffix}`)) suffix += 1;
  return `${base}_${suffix}`;
}

function guardMutatingBodyLiterals(
  steps: Skill['steps'],
  preflightNames: ReadonlySet<string>,
): string[] {
  const notes: string[] = [];
  for (const step of steps) {
    if (!step.hasSideEffect || !step.network?.body) continue;
    visitBodyLeaves(step.network.body, [], (path, value, replace) => {
      if (isTracedTemplate(value)
        || isLiteralExempt(value, step.network!.url)) return;
      const leafName = path.at(-1);
      if (leafName && preflightNames.has(leafName)) {
        replace(`{{${leafName}}}`);
        return;
      }
      replace('TODO_UNRESOLVED');
      notes.push(
        `步骤 ${step.id} 写请求字段 ${path.join('.')} 的字面量 ${JSON.stringify(value)} 无法溯源；` +
        '请确认其来源并显式修正。',
      );
    });
  }
  return notes;
}

function visitBodyLeaves(
  value: Record<string, unknown>,
  path: string[],
  visit: (path: string[], value: unknown, replace: (value: unknown) => void) => void,
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    if (Array.isArray(child)) {
      if (child.length === 0) continue;
      child.forEach((item, index) => {
        if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
          visitBodyLeaves(item as Record<string, unknown>, [...childPath, String(index)], visit);
        } else {
          visit([...childPath, String(index)], item, (replacement) => { child[index] = replacement; });
        }
      });
    } else if (typeof child === 'object' && child !== null) {
      visitBodyLeaves(child as Record<string, unknown>, childPath, visit);
    } else {
      visit(childPath, child, (replacement) => { value[key] = replacement; });
    }
  }
}

function isTracedTemplate(value: unknown): boolean {
  return typeof value === 'string' && /^\{\{[^{}]+\}\}$/.test(value);
}

function isLiteralExempt(value: unknown, requestUrl: string): boolean {
  if (value === null || value === '' || typeof value === 'boolean') return true;
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  let pathname: string;
  try {
    pathname = new URL(requestUrl, 'http://dsh.invalid').pathname;
  } catch {
    pathname = requestUrl.split('?')[0] ?? requestUrl;
  }
  return String(value).length > 0 && pathname.split('/').includes(String(value));
}

function setBodyPath(body: Record<string, unknown>, path: string, value: string): void {
  // 叶子路径由 collectLeaves 用 '.' 拼接产生，key 本身可能含点（如
  // oauth2.device.authorization.grant.enabled），因此按 body 实际结构逐段最长匹配回溯。
  const fullPath = path.replace(/^body\.?/, '');
  const segment = longestKeyPrefix(body, fullPath);
  if (segment === undefined) return;
  const rest = fullPath.slice(segment.length).replace(/^\./, '');
  const child = body[segment];
  if (rest.length === 0) {
    body[segment] = value;
    return;
  }
  if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
    setBodyPath(child as Record<string, unknown>, rest, value);
  }
}

function readBodyPath(body: Record<string, unknown>, path: string): unknown {
  const fullPath = path.replace(/^body\.?/, '');
  const segment = longestKeyPrefix(body, fullPath);
  if (segment === undefined) return undefined;
  const rest = fullPath.slice(segment.length).replace(/^\./, '');
  const child = body[segment];
  if (rest.length === 0) return child;
  if (typeof child !== 'object' || child === null || Array.isArray(child)) return undefined;
  return readBodyPath(child as Record<string, unknown>, rest);
}

function longestKeyPrefix(node: Record<string, unknown>, path: string): string | undefined {
  const candidates = Object.keys(node)
    .filter((key) => path === key || path.startsWith(`${key}.`))
    .sort((left, right) => right.length - left.length);
  return candidates[0];
}

function dynamicHeaders(
  headers: Record<string, string>,
  dependencies: CorrelatedRequest['dependsOn'],
  stepByRequest: Map<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => {
    if (!/^<FROM_PREFLIGHT:[^|>]+\|sha256:[a-f0-9]+>$/.test(value)) return [name, value];
    const dependency = dependencies.find((candidate) => candidate.to === `header.${name}`);
    const sourceStep = dependency ? stepByRequest.get(dependency.from) : undefined;
    return [name, dependency && sourceStep
      ? `{{${sourceStep}.${dependencyTargetName(dependency)}}}`
      : 'TODO_UNRESOLVED'];
  }));
}

function businessHeaderNotes(steps: Skill['steps']): string[] {
  const names = new Set(
    steps.flatMap((step) =>
      Object.entries(step.network?.headers ?? {})
        .filter(([, value]) => !/^<FROM_(?:BROWSER|PREFLIGHT:)/.test(value))
        .map(([name]) => name),
    ),
  );
  if (names.size === 0) return [];
  return [
    `本技能包含 ${names.size} 个录制时业务 header（${[...names].join(', ')}）；若其值需随调用变化，请人工改为参数引用。`,
  ];
}

function inferPostcondition(
  items: DraftItem[],
  params: Skill['params'],
  baseUrl: string,
): Skill['postcondition'] {
  const submit = items.find((item) => item.request?.isSubmit)?.request;
  if (!submit) return undefined;
  const submitBody = safeObjectBody(submit);
  const candidates = items
    .map((item) => item.request)
    .filter((request): request is CorrelatedRequest =>
      request?.method === 'GET'
      && request.requestTs > submit.requestTs
      && request.responseBody !== null,
  );
  for (const candidate of candidates) {
    for (const collection of findJsonCollections(candidate.responseBody!)) {
      const where = Object.fromEntries(
        params.flatMap((param) => {
          if (!(param.name in submitBody)) return [];
          const recorded = submitBody[param.name];
          const matches = collection.items.some(
            (item) => typeof item === 'object' && item !== null
              && String((item as Record<string, unknown>)[param.name]) === String(recorded),
          );
          return matches ? [[param.name, `{{${param.name}${param.type === 'enum' ? '|enumValue' : ''}}}`]] : [];
        }),
      );
      if (Object.keys(where).length === 0) continue;
      const recordedMatch = collection.items.some((item) =>
        typeof item === 'object' && item !== null
        && Object.keys(where).every((name) =>
          String((item as Record<string, unknown>)[name]) === String(submitBody[name]),
        ),
      );
      if (!recordedMatch) continue;
      return {
        request: { method: 'GET', url: relativeUrl(candidate.url, baseUrl) },
        match: { jsonPath: collection.path, where, limit: 5 },
        expectFound: true,
        timeoutMs: 10_000,
      };
    }
  }
  return undefined;
}

function isRedirectingSubmission(session: RecordSession, request: RecordedRequest): boolean {
  if (!request.mutating || request.resourceType !== 'document') return false;
  const owner = session.canonicalActions.find((action) =>
    action.effects?.requestIds?.includes(request.requestId),
  );
  return owner?.effects?.navigation !== undefined;
}

function safeObjectBody(request: RecordedRequest): Record<string, unknown> {
  if (!request.postData) return {};
  try {
    if ((request.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
      return Object.fromEntries(new URLSearchParams(request.postData));
    }
    const value: unknown = JSON.parse(request.postData);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function findJsonCollections(body: string): Array<{ path: string; items: unknown[] }> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }
  return findCollectionNodes(parsed, '$');
}

function findCollectionNodes(value: unknown, path: string): Array<{ path: string; items: unknown[] }> {
  if (Array.isArray(value)) return [{ path: `${path}[*]`, items: value }];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) =>
    findCollectionNodes(child, `${path}.${key}`),
  );
}

function renderDraftYaml(skill: Skill, hasPostcondition: boolean): string {
  const document = new Document(skill);
  document.commentBefore = [
    ' TODO: 请确认参数名称、类型与枚举映射。',
    ' TODO: 请确认每个步骤的 channel 与 riskLevel。',
    ' TODO: 请确认预取值、依赖模板与断言。',
  ].join('\n');
  commentSequence(document, 'params', ' TODO: 请复核此参数推断');
  commentSequence(document, 'preflight', ' TODO: 请复核此 preflight 推断');
  commentSequence(document, 'steps', ' TODO: 请复核此录制步骤');
  commentLowCorrelations(document, skill);
  if (hasPostcondition) {
    const node = document.get('postcondition', true);
    if (isNode(node)) node.commentBefore = ' TODO: 请确认此查询能唯一定位本次提交';
  } else {
    document.comment = [
      ' TODO: 未能自动推断 postcondition。',
      ' 缺少 postcondition 时，提交响应丢失将中止并要求人工判断。',
      ' TODO: 强烈建议手工补一个幂等的 GET 查询。',
      ' TODO: postcondition.request.method 必须为 GET。',
    ].join('\n');
  }
  return document.toString({ lineWidth: 0 });
}

function commentLowCorrelations(document: Document, skill: Skill): void {
  const sequence = document.get('steps', true);
  if (!isSeq(sequence)) return;
  sequence.items.forEach((item, index) => {
    const correlation = skill.steps[index]?._correlation;
    if (!isMap(item) || correlation?.method !== 'time-window') return;
    item.commentBefore = [
      item.commentBefore,
      ' TODO: 此请求的归属由时间窗推断（置信度低）。',
      ' 该请求未携带 actionIdx，可能由页面自动触发而非用户操作。',
      ` ${correlation.evidence}。请确认它是否应归属于 ${correlation.ownerAction}。`,
    ].filter(Boolean).join('\n');
  });
}

function commentSequence(document: Document, key: string, comment: string): void {
  const sequence = document.get(key, true);
  if (!isSeq(sequence)) return;
  for (const item of sequence.items) {
    if (isNode(item)) item.commentBefore = comment;
  }
}

function relativeUrl(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url, baseUrl);
    return parsed.origin === new URL(baseUrl).origin
      ? `${parsed.pathname}${parsed.search}`
      : parsed.href;
  } catch {
    return 'TODO_UNRESOLVED';
  }
}

function stepDescription(item: DraftItem): string {
  if (item.action && item.action.kind !== 'navigate') {
    const visible = item.action.label ?? item.action.text ?? item.action.semanticTarget?.accessibleName;
    if (!visible?.trim()) return 'TODO_UNRESOLVED';
  }
  return item.action?.label ?? item.action?.text ?? item.action?.kind ?? item.request?.url ?? item.id;
}

function skillId(items: DraftItem[]): string {
  const submit = items.find((item) => item.request?.isSubmit)?.request;
  let path = '/recorded/skill';
  try { if (submit) path = new URL(submit.url).pathname; } catch { /* keep generic id */ }
  return path.split('/').filter(Boolean).join('_').replace(/^api_/, '') || 'recorded_skill';
}
