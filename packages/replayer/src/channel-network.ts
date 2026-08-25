import { TIMEOUTS, resolveTemplate } from '@dsh/core';
import { BearerUnavailableError } from '@dsh/core';
import type { ExecContext, ParamDefinition, Step, StepResult } from '@dsh/core';
import { getLiveAuthHeader } from '@dsh/browser';
import type { Page } from 'playwright';

interface BrowserFetchResult {
  fetchStarted: boolean;
  status: number | null;
  text: string | null;
  error?: string;
}

/** 在页面会话中执行 network 步骤，并按 fetch 调用边界机械分类结果。 */
export async function executeNetworkStep(
  page: Page,
  step: Step,
  context: ExecContext,
  params: readonly ParamDefinition[],
): Promise<StepResult> {
  const startedAt = Date.now();
  if (!step.network) return notSent(step.id, startedAt, '步骤缺少 network 配置');
  let requests: Array<NonNullable<Step['network']>>;
  try {
    validateParams(params, context.params);
    requests = expandRequests(step.network, context, params);
    requests.forEach((request) => new URL(request.url, context.baseUrl));
  } catch (error) {
    return notSent(step.id, startedAt, String(error));
  }

  // 【C18】按 entry.sessionType 分流：bearer/mixed 需就地取用 Authorization 头。
  // 取不到 → BearerUnavailableError → not_sent（可安全降级 ui）；
  // token 只存本次调用的内存，每步重新取，不缓存、不落盘。
  let liveAuthorization: string | null = null;
  const sessionType = context.entry.entry.sessionType;
  if (sessionType === 'bearer' || sessionType === 'mixed') {
    const source = context.entry.entry.bearerSource;
    if (!source) {
      return notSent(step.id, startedAt, `entry.sessionType=${sessionType} 但未配置 bearerSource，请先跑 dsh doctor --probe-entry`);
    }
    try {
      liveAuthorization = await getLiveAuthHeader(page, source);
    } catch (error) {
      return notSent(step.id, startedAt, `bearer 就地取用失败: ${String(error)}`);
    }
    if (!liveAuthorization) {
      return notSentWrapped(step.id, startedAt, new BearerUnavailableError(
        `entry "${context.entry.entry.id}" 会话为 bearer/${source.strategy}，无法就地取用 Authorization 头`,
      ));
    }
  } else if (sessionType === 'unknown') {
    return notSent(step.id, startedAt, 'entry.sessionType=unknown，请先执行 dsh doctor --probe-entry 探测');
  }

  try {
    requests = requests.map((request) =>
      materializeRuntimeHeaders(request, context, liveAuthorization),
    );
  } catch (error) {
    return notSent(step.id, startedAt, String(error));
  }

  const extracted: Array<Record<string, unknown>> = [];
  let lastRaw: StepResult['raw'];
  for (const request of requests) {
    const result = await browserFetch(page, request, context.baseUrl, liveAuthorization);
    if (!result.fetchStarted) return notSent(step.id, startedAt, result.error ?? '未调用 fetch');
    if (result.status === null) {
      return {
        stepId: step.id,
        ok: false,
        outcome: 'outcome_unknown',
        channelUsed: 'network',
        durationMs: Date.now() - startedAt,
        error: `status=null: ${result.error ?? 'fetch failed'}`,
      };
    }
    lastRaw = { status: result.status, text: result.text ?? undefined };
    if (result.status < 200 || result.status >= 300) {
      const outcome = explicitRejection(result.status, result.text)
        ? 'confirmed_failure'
        : 'outcome_unknown';
      return {
        stepId: step.id,
        ok: false,
        outcome,
        channelUsed: 'network',
        durationMs: Date.now() - startedAt,
        error: `HTTP ${result.status}`,
        raw: lastRaw,
      };
    }
    try {
      extracted.push(extractResponse(result.text ?? '', request.extract));
    } catch (error) {
      return {
        stepId: step.id,
        ok: false,
        outcome: 'outcome_unknown',
        channelUsed: 'network',
        durationMs: Date.now() - startedAt,
        error: String(error),
        raw: lastRaw,
      };
    }
  }
  const stepValue = requests.length === 1 ? extracted[0] ?? {} : extracted;
  context.stepResults[step.id] = stepValue;
  return {
    stepId: step.id,
    ok: true,
    outcome: 'confirmed_success',
    channelUsed: 'network',
    durationMs: Date.now() - startedAt,
    raw: lastRaw,
  };
}

function materializeRuntimeHeaders(
  request: NonNullable<Step['network']>,
  context: ExecContext,
  liveAuthorization: string | null,
): NonNullable<Step['network']> {
  const headers = Object.fromEntries(
    Object.entries(request.headers ?? {}).map(([name, value]) => {
      if (value === '<FROM_BROWSER>') {
        if (!liveAuthorization) throw new BearerUnavailableError('无法从当前浏览器会话取得 Authorization');
        return [name, liveAuthorization];
      }
      const preflight = /^<FROM_PREFLIGHT:([^>]+)>$/.exec(value)?.[1];
      if (preflight) {
        const resolved = context.vars[preflight];
        if (resolved === undefined) throw new Error(`preflight 变量不存在: ${preflight}`);
        return [name, String(resolved)];
      }
      return [name, value];
    }),
  );
  return { ...request, headers };
}

async function browserFetch(
  page: Page,
  request: NonNullable<Step['network']>,
  baseUrl: string,
  liveAuthorization: string | null,
): Promise<BrowserFetchResult> {
  return page.evaluate(
    async ({ spec, origin, timeoutMs, authorization }) => {
      let fetchStarted = false;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const headers = new Headers(spec.headers);
        // 【C18】bearer/mixed：注入就地取用的 Authorization（每步现取，不缓存）
        if (authorization && !headers.has('authorization')) {
          headers.set('authorization', authorization);
        }
        let body: string | undefined;
        if (spec.body) {
          if (spec.contentType === 'form') {
            headers.set('content-type', 'application/x-www-form-urlencoded');
            body = new URLSearchParams(
              Object.entries(spec.body).map(([key, value]) => [key, String(value)]),
            ).toString();
          } else {
            headers.set('content-type', 'application/json');
            body = JSON.stringify(spec.body);
          }
        }
        fetchStarted = true;
        const response = await fetch(new URL(spec.url, origin).href, {
          method: spec.method,
          credentials: 'include',
          headers,
          body,
          signal: controller.signal,
        });
        clearTimeout(timer);
        return { fetchStarted, status: response.status, text: await response.text() };
      } catch (error) {
        return {
          fetchStarted,
          error: String(error),
          status: null,
          text: null,
        };
      }
    },
    { spec: request, origin: baseUrl, timeoutMs: TIMEOUTS.networkStep, authorization: liveAuthorization },
  );
}

function expandRequests(
  network: NonNullable<Step['network']>,
  context: ExecContext,
  params: readonly ParamDefinition[],
): NonNullable<Step['network']>[] {
  const serialized = JSON.stringify(network);
  const loopRoot = /\{\{\s*([A-Za-z_$][\w$]*)\[i\]/.exec(serialized)?.[1];
  if (!loopRoot) return [resolveTemplate(network, context, params)];
  const items = context.params[loopRoot] ?? context.vars[loopRoot];
  if (!Array.isArray(items)) throw new Error(`循环变量不是数组: ${loopRoot}`);
  return items.map((_item, index) =>
    resolveTemplate(
      JSON.parse(serialized.replaceAll(`[i]`, `[${index}]`)) as NonNullable<Step['network']>,
      context,
      params,
    ),
  );
}

function validateParams(
  definitions: readonly ParamDefinition[],
  values: Record<string, unknown>,
): void {
  for (const definition of definitions) {
    const value = values[definition.name];
    if (definition.required && value === undefined) {
      throw new Error(`缺少必填参数: ${definition.name}`);
    }
    if (value === undefined) continue;
    if (definition.type === 'number' && typeof value !== 'number') {
      throw new Error(`参数类型错误: ${definition.name}`);
    }
    if (definition.type === 'boolean' && typeof value !== 'boolean') {
      throw new Error(`参数类型错误: ${definition.name}`);
    }
    if (definition.type === 'enum' && !definition.values?.some((item) => item.label === value)) {
      throw new Error(`枚举参数值无效: ${definition.name}`);
    }
  }
}

function extractResponse(
  text: string,
  extract: Record<string, string> | undefined,
): Record<string, unknown> {
  if (!extract || Object.keys(extract).length === 0) return {};
  const body: unknown = JSON.parse(text);
  return Object.fromEntries(
    Object.entries(extract).map(([name, path]) => [name, readJsonPath(body, path)]),
  );
}

function readJsonPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      throw new Error(`JSONPath 未找到: ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function explicitRejection(status: number, text: string | null): boolean {
  return status >= 400 && status < 500 && Boolean(text?.trim());
}

function notSent(stepId: string, startedAt: number, error: string): StepResult {
  return {
    stepId,
    ok: false,
    outcome: 'not_sent',
    channelUsed: 'network',
    durationMs: Date.now() - startedAt,
    error,
  };
}

/** BearerUnavailableError 场景：not_sent 且把错误对象挂到 error 链（可安全降级 ui）。 */
function notSentWrapped(stepId: string, startedAt: number, error: Error): StepResult {
  const result = notSent(stepId, startedAt, error.message);
  return { ...result, error: `${error.message} [${(error as { code?: string }).code ?? ''}]` };
}
