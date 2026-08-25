import { SkillSchema, UnusedParameterError } from '@dsh/core';
import type { RecordedAction, RecordedRequest, RecordSession, Skill } from '@dsh/core';
import { Document, isMap, isNode, isSeq } from 'yaml';

import { correlate, type CorrelatedRequest } from './correlate.js';
import { detectParams } from './params.js';
import { detectPreflight } from './preflight.js';

interface DraftItem {
  id: string;
  action: RecordedAction | null;
  request: CorrelatedRequest | null;
  hasSideEffect: boolean;
  afterSessionInterrupt: boolean;
  sourceActionIndex: number;
  expectsRedirect: boolean;
}

export interface DraftResult {
  skill: Skill;
  yaml: string;
}

/** 将一次录制转为可校验、待人工复核的技能草稿。 */
export function generateDraft(session: RecordSession, secondSession?: RecordSession): DraftResult {
  const correlated = correlate(session);
  const params = detectParams(session, secondSession).map((candidate) => candidate.definition);
  const items: DraftItem[] = [];
  const interruptionIndexes = new Set(session.interruptions?.map((item) => item.atActionIdx) ?? []);
  const networkOwnedScopes = new Set(
    correlated.flatMap((producer, producerIndex) => {
      const scopeId = producer.action?.produces?.scopeId;
      if (!scopeId || producer.requests.length > 0) return [];
      const consumer = correlated
        .slice(producerIndex + 1)
        .find((candidate) => candidate.action?.scope === scopeId);
      return consumer?.requests.some((request) => request.mutating) ? [scopeId] : [];
    }),
  );
  for (const step of correlated) {
    const recordedAction = step.action;
    const actionIndex = recordedAction ? session.actions.indexOf(recordedAction) : -1;
    if (recordedAction?.produces && networkOwnedScopes.has(recordedAction.produces.scopeId)) {
      continue;
    }
    const action = recordedAction?.scope && networkOwnedScopes.has(recordedAction.scope)
      ? { ...recordedAction, scope: undefined }
      : recordedAction;
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
  const recordedInputs: RecordedAction[] = [
    ...session.actions,
    ...(session.initialFormState ?? []).map((state) => ({ ...state })),
  ];
  const extracts = dependencyExtracts(items, params, recordedInputs);
  const preflight = detectPreflight(session);
  const steps: Skill['steps'] = items.map(
    (item) =>
      draftStep(
        item,
        params,
        stepByRequest,
        extracts,
        session.meta.baseUrl,
        stepByActionIndex,
        recordedInputs,
      ) as Skill['steps'][number],
  );
  const provenanceNotes = guardMutatingBodyLiterals(
    steps,
    new Set(preflight.map((item) => item.name)),
  );
  const postcondition = inferPostcondition(items, params, session.meta.baseUrl);
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
    params,
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
    ],
  };
  const skill = SkillSchema.parse(raw);
  assertParametersUsed(skill);
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
  recordedInputs: RecordedAction[],
): unknown {
  const request = item.request;
  const ui = item.action ? uiAction(item.action, params, item.afterSessionInterrupt) : undefined;
  const network = request
    ? networkAction(
        request, params, stepByRequest, extracts.get(request.requestId), baseUrl, recordedInputs,
      )
    : item.action?.type === 'navigate'
      ? {
          method: 'GET',
          url: relativeUrl(item.action.url ?? baseUrl, baseUrl),
          contentType: 'json',
        }
      : undefined;
  const critical = request && /approve|delete|pay/i.test(request.url);
  return {
    id: item.id,
    desc: stepDescription(item),
    channel:
      item.action?.type === 'navigate'
        ? 'ui'
        : request?.mutating || (request && !ui)
        ? 'network'
        : item.action?.type === 'fill' || item.action?.type === 'datetime'
          ? 'merged'
          : 'ui',
    riskLevel: critical ? 'critical' : request?.mutating ? 'write' : 'read',
    hasSideEffect: item.hasSideEffect,
    ...(item.expectsRedirect ? { expectsRedirect: true } : {}),
    ...(network ? { network } : {}),
    ...(ui ? { ui } : {}),
    ...(item.action?.scope && !item.afterSessionInterrupt ? { requires: [item.action.scope] } : {}),
    ...(item.action?.produces ? { produces: item.action.produces } : {}),
    ...(item.action?.waitAfter ? { waitAfter: item.action.waitAfter } : {}),
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
  recordedInputs: RecordedAction[],
): unknown {
  const contentType = (request.headers['content-type'] ?? '').includes(
    'application/x-www-form-urlencoded',
  )
    ? 'form'
    : 'json';
  const body = requestBody(request, contentType);
  parameterizeBody(body, params);
  for (const dependency of request.dependsOn) {
    const targetParam = params.find((param) => dependency.to.split('.').at(-1) === param.name);
    if (targetParam) continue;
    const dependencyPath = resolvedDependencyPath(dependency, params, recordedInputs);
    if (!dependencyPath) {
      setBodyPath(body, dependency.to, 'TODO_UNRESOLVED');
      continue;
    }
    const sourceStep = stepByRequest.get(dependency.from);
    if (!sourceStep) throw new Error(`依赖源请求未生成步骤: ${dependency.from}`);
    setBodyPath(body, dependency.to, `{{${sourceStep}.${dependencyTargetName(dependency)}}}`);
  }
  const headers = dynamicHeaders(request.headers);
  return {
    method: request.method,
    url: parameterizeUrl(relativeUrl(request.url, baseUrl), params, recordedInputs),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    contentType,
    ...(Object.keys(body).length > 0 ? { body } : {}),
    ...(extract && Object.keys(extract).length > 0 ? { extract } : {}),
  };
}

function uiAction(action: RecordedAction, params: Skill['params'], discardScope = false): unknown {
  const name = params.find((param) => param.prompt === action.label)?.name;
  const value = name ? `{{${name}}}` : action.value;
  const common = {
    ...(action.target ? { target: action.target } : {}),
    ...(action.label ? { label: action.label } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(action.scope && !discardScope ? { scope: action.scope } : {}),
    ...(action.recordedHint ? { recordedHint: action.recordedHint } : {}),
  };
  if (action.type === 'select') return { action: 'selectOption', ...common };
  if (action.type === 'radio' || action.type === 'checkbox') {
    return { action: 'check', ...common, checked: action.checked ?? true };
  }
  if (action.type === 'datetime') return { action: 'setDateTime', ...common };
  if (action.type === 'navigate') return { action: 'navigate', url: action.url };
  return { action: action.type, ...common };
}

function dependencyExtracts(
  items: DraftItem[],
  params: Skill['params'],
  recordedInputs: RecordedAction[],
): Map<string, Record<string, string>> {
  const extracts = new Map<string, Record<string, string>>();
  for (const item of items) {
    for (const dependency of item.request?.dependsOn ?? []) {
      const path = resolvedDependencyPath(dependency, params, recordedInputs);
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
  recordedInputs: RecordedAction[],
): string | undefined {
  if (dependency.ambiguous) return undefined;
  if (!dependency.discriminator) return dependency.path;
  const action = recordedInputs[dependency.discriminator.actionIndex];
  const param = action ? parameterForAction(action, params) : undefined;
  const indexed = /^(.*)\[\d+\](.*)$/.exec(dependency.path);
  if (!param || !indexed || !/^[A-Za-z_$][\w$]*$/.test(dependency.discriminator.field)) {
    return undefined;
  }
  return `${indexed[1]}[?(@.${dependency.discriminator.field}=="{{${param.name}}}")]${indexed[2]}`;
}

function dependencyTargetName(dependency: CorrelatedRequest['dependsOn'][number]): string {
  return dependency.to.split('.').at(-1) ?? 'value';
}

function parameterizeUrl(
  url: string,
  params: Skill['params'],
  recordedInputs: RecordedAction[],
): string {
  return url.replace(/([?&][^=&#]+=)([^&#]*)/g, (match, prefix: string, encoded: string) => {
    let value: string;
    try {
      value = decodeURIComponent(encoded.replace(/\+/g, ' '));
    } catch {
      return match;
    }
    const candidates = recordedInputs
      .filter((action) => action.value === value)
      .map((action) => parameterForAction(action, params))
      .filter((param): param is Skill['params'][number] => param !== undefined);
    const unique = [...new Map(candidates.map((param) => [param.name, param])).values()];
    return unique.length === 1 ? `${prefix}{{${unique[0]!.name}}}` : match;
  });
}

function parameterForAction(
  action: RecordedAction,
  params: Skill['params'],
): Skill['params'][number] | undefined {
  return params.find((param) =>
    (action.name && param.name === action.name)
    || (action.label && param.prompt === action.label)
    || param.values?.some((value) => value.label === action.value || value.value === action.value),
  );
}

function requestBody(
  request: RecordedRequest,
  contentType: 'json' | 'form',
): Record<string, unknown> {
  if (!request.postData) return {};
  return contentType === 'json'
    ? JSON.parse(request.postData)
    : Object.fromEntries(new URLSearchParams(request.postData));
}

function parameterizeBody(body: Record<string, unknown>, params: Skill['params']): void {
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parameterizeBody(value as Record<string, unknown>, params);
      continue;
    }
    const param = params.find((candidate) => candidate.name === key);
    if (param) body[key] = `{{${param.name}${param.type === 'enum' ? '|enumValue' : ''}}}`;
  }
}

function guardMutatingBodyLiterals(
  steps: Skill['steps'],
  preflightNames: ReadonlySet<string>,
): string[] {
  const notes: string[] = [];
  for (const step of steps) {
    if (!step.hasSideEffect || !step.network?.body) continue;
    visitBodyLeaves(step.network.body, [], (path, value, replace) => {
      if (isTracedTemplate(value) || isLiteralExempt(value, step.network!.url)) return;
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

function longestKeyPrefix(node: Record<string, unknown>, path: string): string | undefined {
  const candidates = Object.keys(node)
    .filter((key) => path === key || path.startsWith(`${key}.`))
    .sort((left, right) => right.length - left.length);
  return candidates[0];
}

function dynamicHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers };
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
  const nextActionTs = session.actions.find((action) => action.ts > request.requestTs)?.ts;
  const before = [...session.pages]
    .filter((page) => page.ts <= request.requestTs)
    .sort((left, right) => right.ts - left.ts)[0];
  const after = [...session.pages]
    .filter((page) => page.ts >= request.requestTs && (nextActionTs === undefined || page.ts < nextActionTs))
    .sort((left, right) => left.ts - right.ts)[0];
  if (!after) return false;
  return !before || withoutHash(before.url) !== withoutHash(after.url);
}

function withoutHash(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  return parsed.href;
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
    if (!isMap(item) || correlation?.confidence !== 'low') return;
    item.commentBefore = [
      item.commentBefore,
      ' TODO: 此请求的归属由时间窗推断（置信度低）。',
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
  const parsed = new URL(url, baseUrl);
  return parsed.origin === new URL(baseUrl).origin
    ? `${parsed.pathname}${parsed.search}`
    : parsed.href;
}

function stepDescription(item: DraftItem): string {
  return (
    item.action?.label ?? item.action?.text ?? item.action?.type ?? item.request?.url ?? item.id
  );
}

function skillId(items: DraftItem[]): string {
  const submit = items.find((item) => item.request?.isSubmit)?.request;
  const path = submit ? new URL(submit.url).pathname : '/recorded/skill';
  return path.split('/').filter(Boolean).join('_').replace(/^api_/, '') || 'recorded_skill';
}
