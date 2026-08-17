import type { RecordedRequest, RecordSession } from '@dsh/core';

export interface PreflightDraft {
  name: string;
  request?: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string> };
  extract:
    | { type: 'dom'; selector: string; attribute: string }
    | { type: 'jsonPath'; path: string }
    | { type: 'regex'; pattern: string; group: number };
}

export interface AuthDraft {
  probeUrl: string;
  sessionApi?: string;
  loggedInJsonPath?: string;
  loginUrlPatterns: string[];
  loginDomMarkers?: string[];
  loginTimeoutMs: number;
}

export interface AuthDetection {
  auth?: AuthDraft;
  forbiddenUrls: string[];
}

/** 从已录制请求中提取运行时动态值的获取方式。 */
export function detectPreflight(session: RecordSession): PreflightDraft[] {
  const drafts: PreflightDraft[] = [];
  if (session.network.some(hasCsrfHeader)) {
    drafts.push({
      name: 'csrfToken',
      extract: {
        type: 'dom',
        selector: 'meta[name="csrf-token"]',
        attribute: 'content',
      },
    });
  }

  for (const request of session.network) {
    const form = formFields(request);
    for (const name of ['__VIEWSTATE', '__EVENTVALIDATION']) {
      if (!form.has(name)) continue;
      drafts.push({
        name,
        request: { method: 'GET', url: currentFormUrl(session, request) },
        extract: { type: 'dom', selector: `input[name="${name}"]`, attribute: 'value' },
      });
    }
    const jsonToken = jsonTokenField(request);
    if (jsonToken) {
      drafts.push({
        name: jsonToken,
        request: { method: 'GET', url: request.url },
        extract: { type: 'jsonPath', path: `$.${jsonToken}` },
      });
    }
  }
  return uniquePreflights(drafts);
}

/** 只根据明确登录页与会话接口证据生成认证建议。 */
export function detectAuth(session: RecordSession): AuthDetection {
  const forbiddenUrls = session.network
    .filter((request) => request.status === 403)
    .map((request) => request.url);
  const loginPages = session.pages.filter(
    (page) => /\/(login|signin|sso)(\/|$|\?)/i.test(new URL(page.url).pathname),
  );
  const loginUrlPatterns = [
    ...new Set(loginPages.map((page) => new URL(page.url).pathname)),
  ];
  const loginDomMarkers = session.network.some(
    (request) =>
      request.responseBody?.includes('type="password"') ||
      request.responseBody?.includes("type='password'"),
  )
    ? ['input[type="password"]']
    : undefined;
  const sessionRequest = session.network.find(
    (request) =>
      request.method === 'GET' && /\/api\/(session|user\/current|current\/user|me)(\?|$)/i.test(request.url),
  );
  if (!sessionRequest && loginUrlPatterns.length === 0 && !loginDomMarkers) {
    return { forbiddenUrls };
  }
  return {
    auth: {
      probeUrl: sessionRequest?.url ?? session.meta.baseUrl,
      sessionApi: sessionRequest?.url,
      loggedInJsonPath: hasLoggedInBoolean(sessionRequest) ? '$.loggedIn' : undefined,
      loginUrlPatterns,
      loginDomMarkers,
      loginTimeoutMs: 300_000,
    },
    forbiddenUrls,
  };
}

function hasCsrfHeader(request: RecordedRequest): boolean {
  return Object.keys(request.headers).some((name) =>
    /^(x-csrf-token|x-xsrf-token|__requestverificationtoken)$/i.test(name),
  );
}

function formFields(request: RecordedRequest): URLSearchParams {
  const contentType = request.headers['content-type'] ?? '';
  return contentType.includes('application/x-www-form-urlencoded') && request.postData
    ? new URLSearchParams(request.postData)
    : new URLSearchParams();
}

function currentFormUrl(session: RecordSession, request: RecordedRequest): string {
  const referer = Object.entries(request.headers).find(([name]) => /^referer$/i.test(name))?.[1];
  return referer ?? session.pages.at(-1)?.url ?? session.meta.baseUrl;
}

function jsonTokenField(request: RecordedRequest): string | undefined {
  if (request.method !== 'GET' || !/(csrf|token)/i.test(request.url) || !request.responseBody) {
    return undefined;
  }
  try {
    const body: unknown = JSON.parse(request.responseBody);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    return Object.keys(body).find((key) => /token/i.test(key));
  } catch {
    return undefined;
  }
}

function hasLoggedInBoolean(request: RecordedRequest | undefined): boolean {
  if (!request?.responseBody) return false;
  try {
    const body: unknown = JSON.parse(request.responseBody);
    return (
      typeof body === 'object' &&
      body !== null &&
      'loggedIn' in body &&
      typeof (body as { loggedIn: unknown }).loggedIn === 'boolean'
    );
  } catch {
    return false;
  }
}

function uniquePreflights(drafts: PreflightDraft[]): PreflightDraft[] {
  return [...new Map(drafts.map((draft) => [draft.name, draft])).values()];
}
