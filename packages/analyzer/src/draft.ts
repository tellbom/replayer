import { SkillSchema } from '@dsh/core';
import type { RecordedAction, RecordedRequest, RecordSession, Skill } from '@dsh/core';
import { Document, isNode, isSeq } from 'yaml';

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
  for (const step of correlated) {
    const actionIndex = step.action ? session.actions.indexOf(step.action) : -1;
    const afterSessionInterrupt = interruptionIndexes.has(actionIndex);
    if (step.requests.length === 0 && step.action) {
      items.push({
        id: '',
        action: step.action,
        request: null,
        hasSideEffect: false,
        afterSessionInterrupt,
        sourceActionIndex: actionIndex,
      });
      continue;
    }
    step.requests.forEach((request, index) => {
      items.push({
        id: '',
        action: index === 0 ? step.action : null,
        request,
        hasSideEffect: request.mutating,
        afterSessionInterrupt: index === 0 && afterSessionInterrupt,
        sourceActionIndex: actionIndex,
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
  const extracts = dependencyExtracts(items);
  const steps: Skill['steps'] = items.map(
    (item) =>
      draftStep(
        item,
        params,
        stepByRequest,
        extracts,
        session.meta.baseUrl,
      ) as Skill['steps'][number],
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
    preflight: detectPreflight(session),
    steps,
    assertions: [{ type: 'httpStatus', expect: 200 }],
    ...(postcondition ? { postcondition } : {}),
    ...(reentryDraft(steps) ? { reentry: reentryDraft(steps) } : {}),
    _notes: [
      '动作与请求仅按 requestTs 关联。',
      '参数来自用户 fill/select/datetime 动作。',
      '跨请求依赖来自结构化脱敏后的叶子值匹配。',
      '所有 TODO 项必须在发布前人工确认。',
      '认证载体见 entries/ 目录（C16：技能不含登录环节）。',
      '若未生成 reentry：首步即写时无幂等 anchor 可用，请人工前移幂等步骤（C22）。',
      ...sessionInterruptNotes(items, session),
    ],
  };
  const skill = SkillSchema.parse(raw);
  return { skill, yaml: renderDraftYaml(skill, Boolean(postcondition)) };
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
): unknown {
  const request = item.request;
  const ui = item.action ? uiAction(item.action, params, item.afterSessionInterrupt) : undefined;
  const network = request
    ? networkAction(request, params, stepByRequest, extracts.get(request.requestId), baseUrl)
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
      request?.mutating || item.action?.type === 'navigate' || (request && !ui)
        ? 'network'
        : item.action?.type === 'fill' || item.action?.type === 'datetime'
          ? 'merged'
          : 'ui',
    riskLevel: critical ? 'critical' : request?.mutating ? 'write' : 'read',
    hasSideEffect: item.hasSideEffect,
    ...(network ? { network } : {}),
    ...(ui ? { ui } : {}),
    ...(item.action?.scope && !item.afterSessionInterrupt ? { requires: [item.action.scope] } : {}),
    ...(item.action?.produces ? { produces: item.action.produces } : {}),
    ...(item.action?.waitAfter ? { waitAfter: item.action.waitAfter } : {}),
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
): unknown {
  const contentType = (request.headers['content-type'] ?? '').includes(
    'application/x-www-form-urlencoded',
  )
    ? 'form'
    : 'json';
  const body = requestBody(request, contentType);
  parameterizeBody(body, params);
  for (const dependency of request.dependsOn) {
    const sourceStep = stepByRequest.get(dependency.from);
    if (!sourceStep) throw new Error(`依赖源请求未生成步骤: ${dependency.from}`);
    setBodyPath(body, dependency.to, `{{${sourceStep}${dependency.path.slice(1)}}}`);
  }
  const headers = dynamicHeaders(request.headers);
  return {
    method: request.method,
    url: relativeUrl(request.url, baseUrl),
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
  };
  if (action.type === 'select') return { action: 'selectOption', ...common };
  if (action.type === 'datetime') return { action: 'setDateTime', ...common };
  if (action.type === 'navigate') return { action: 'navigate', url: action.url };
  return { action: action.type, ...common };
}

function dependencyExtracts(items: DraftItem[]): Map<string, Record<string, string>> {
  const extracts = new Map<string, Record<string, string>>();
  for (const item of items) {
    for (const dependency of item.request?.dependsOn ?? []) {
      const name = dependency.path.split('.').at(-1);
      if (!name) continue;
      const current = extracts.get(dependency.from) ?? {};
      current[name] = dependency.path;
      extracts.set(dependency.from, current);
    }
  }
  return extracts;
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
  const output: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    if (/^(x-csrf-token|x-xsrf-token|__requestverificationtoken)$/i.test(name)) {
      output[name] = '{{csrfToken}}';
    }
  }
  return output;
}

function inferPostcondition(
  items: DraftItem[],
  params: Skill['params'],
  baseUrl: string,
): Skill['postcondition'] {
  const submitTs = items.find((item) => item.request?.isSubmit)?.request?.requestTs;
  const candidate = items.find(
    (item) =>
      item.request?.method === 'GET' &&
      /history|list/i.test(item.request.url) &&
      (submitTs === undefined || item.request.requestTs > submitTs),
  )?.request;
  if (!candidate) return undefined;
  const where = Object.fromEntries(
    params
      .filter((param) => param.name === 'reason' || param.name === 'startTime')
      .map((param) => [param.name, `{{${param.name}}}`]),
  );
  return {
    request: { method: 'GET', url: relativeUrl(candidate.url, baseUrl) },
    match: { jsonPath: '$.list[*]', where, limit: 5 },
    expectFound: true,
    timeoutMs: 10_000,
  };
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
