import { SkillSchema } from '@dsh/core';
import type { RecordedAction, RecordedRequest, RecordSession, Skill } from '@dsh/core';
import { Document, isNode, isSeq } from 'yaml';

import { correlate, type CorrelatedRequest } from './correlate.js';
import { detectParams } from './params.js';
import { detectAuth, detectPreflight } from './preflight.js';

interface DraftItem {
  id: string;
  action: RecordedAction | null;
  request: CorrelatedRequest | null;
  hasSideEffect: boolean;
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
  for (const step of correlated) {
    if (step.requests.length === 0 && step.action) {
      items.push({ id: '', action: step.action, request: null, hasSideEffect: false });
      continue;
    }
    step.requests.forEach((request, index) => {
      items.push({
        id: '',
        action: index === 0 ? step.action : null,
        request,
        hasSideEffect: request.mutating,
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
  const steps = items.map((item) => draftStep(item, params, stepByRequest, extracts, session.meta.baseUrl));
  const auth = detectAuth(session).auth;
  const postcondition = inferPostcondition(items, params, session.meta.baseUrl);
  const raw = {
    skill: {
      id: skillId(items),
      name: '录制技能草稿',
      description: '根据浏览器录制自动生成，发布前需复核 TODO',
      system: new URL(session.meta.baseUrl).hostname,
      baseUrl: session.meta.baseUrl,
      version: 1,
      recordedAt: session.meta.endedAt,
    },
    ...(auth ? { auth } : {}),
    params,
    preflight: detectPreflight(session),
    steps,
    assertions: [{ type: 'httpStatus', expect: 200 }],
    ...(postcondition ? { postcondition } : {}),
    _notes: [
      '动作与请求仅按 requestTs 关联。',
      '参数来自用户 fill/select/datetime 动作。',
      '跨请求依赖来自结构化脱敏后的叶子值匹配。',
      '所有 TODO 项必须在发布前人工确认。',
    ],
  };
  const skill = SkillSchema.parse(raw);
  return { skill, yaml: renderDraftYaml(skill, Boolean(postcondition)) };
}

function draftStep(
  item: DraftItem,
  params: Skill['params'],
  stepByRequest: Map<string, string>,
  extracts: Map<string, Record<string, string>>,
  baseUrl: string,
): unknown {
  const request = item.request;
  const ui = item.action ? uiAction(item.action, params) : undefined;
  const network = request
    ? networkAction(request, params, stepByRequest, extracts.get(request.requestId), baseUrl)
    : item.action?.type === 'navigate'
      ? { method: 'GET', url: relativeUrl(item.action.url ?? baseUrl, baseUrl), contentType: 'json' }
      : undefined;
  const critical = request && /approve|delete|pay/i.test(request.url);
  return {
    id: item.id,
    desc: stepDescription(item),
    channel: request?.mutating || item.action?.type === 'navigate' || (request && !ui)
      ? 'network'
      : item.action?.type === 'fill' || item.action?.type === 'datetime'
        ? 'merged'
        : 'ui',
    riskLevel: critical ? 'critical' : request?.mutating ? 'write' : 'read',
    hasSideEffect: item.hasSideEffect,
    ...(network ? { network } : {}),
    ...(ui ? { ui } : {}),
  };
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

function uiAction(action: RecordedAction, params: Skill['params']): unknown {
  const name = params.find((param) => param.prompt === action.label)?.name;
  const value = name ? `{{${name}}}` : action.value;
  const common = {
    ...(action.target ? { target: action.target } : {}),
    ...(action.label ? { label: action.label } : {}),
    ...(value !== undefined ? { value } : {}),
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

function requestBody(request: RecordedRequest, contentType: 'json' | 'form'): Record<string, unknown> {
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
  const segments = path.replace(/^body\.?/, '').split('.').filter(Boolean);
  let current = body;
  for (const segment of segments.slice(0, -1)) {
    current = current[segment] as Record<string, unknown>;
  }
  const leaf = segments.at(-1);
  if (leaf) current[leaf] = value;
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
  return item.action?.label ?? item.action?.text ?? item.action?.type ?? item.request?.url ?? item.id;
}

function skillId(items: DraftItem[]): string {
  const submit = items.find((item) => item.request?.isSubmit)?.request;
  const path = submit ? new URL(submit.url).pathname : '/recorded/skill';
  return path.split('/').filter(Boolean).join('_').replace(/^api_/, '') || 'recorded_skill';
}
