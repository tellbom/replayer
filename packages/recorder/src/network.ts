import { NOISE_PATTERNS, createSanitizer } from '@dsh/core';
import type { RecordedRequest, SanitizeMode } from '@dsh/core';
import type { Page, Request, Response } from 'playwright';

export interface NetworkRecording {
  readonly records: RecordedRequest[];
  setEnabled(enabled: boolean): void;
  stop(): Promise<RecordedRequest[]>;
}

/**
 * 监听 Playwright 网络事件，并且只在内存中保留脱敏后的记录。
 * 【C19】excludeMatchers 命中的一跳认证 URL 不录制。
 */
export function startNetworkRecording(
  page: Page,
  excludeMatchers: RegExp[] = [],
): NetworkRecording {
  const sanitizer = createSanitizer();
  const records: RecordedRequest[] = [];
  const byRequest = new Map<Request, RecordedRequest>();
  const pending = new Set<Promise<void>>();
  let sequence = 0;
  let enabled = true;

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const onRequest = (request: Request): void => {
    if (!enabled) return;
    const method = request.method();
    const resourceType = request.resourceType();
    const rawUrl = request.url();
    if (shouldDiscard(method, resourceType, rawUrl)) return;
    if (excludeMatchers.some((re) => re.test(rawUrl))) return;

    const initialHeaders = request.headers();
    const postData = request.postData();
    const body = sanitizeBody(postData, initialHeaders['content-type'], sanitizer);
    const record: RecordedRequest = {
      requestId: `request-${++sequence}`,
      requestTs: Date.now(),
      responseTs: null,
      method,
      url: sanitizer.sanitizeUrl(rawUrl),
      resourceType,
      headers: sanitizer.sanitizeHeaders(initialHeaders),
      postData: body.value,
      status: null,
      responseBody: null,
      mutating: method !== 'GET',
      sanitizeMode: body.mode,
    };
    records.push(record);
    byRequest.set(request, record);

    track(
      request.allHeaders().then((headers) => {
        record.headers = sanitizer.sanitizeHeaders(headers);
      }),
    );
  };

  const onResponse = (response: Response): void => {
    const record = byRequest.get(response.request());
    if (!record) return;
    track(
      Promise.all([response.allHeaders(), response.text().catch(() => null)]).then(
        ([headers, responseBody]) => {
          record.responseTs = Date.now();
          record.status = response.status();
          if (responseBody === null) return;
          const body = sanitizeBody(responseBody, headers['content-type'], sanitizer);
          record.responseBody = body.value;
          record.sanitizeMode = mergeSanitizeMode(record.sanitizeMode, body.mode);
        },
      ),
    );
  };

  const onRequestFailed = (request: Request): void => {
    const record = byRequest.get(request);
    if (!record) return;
    const errorText = request.failure()?.errorText;
    if (errorText) record.networkError = sanitizer.sanitizeText(errorText);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);

  return {
    records,
    setEnabled(value) {
      enabled = value;
    },
    async stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      await Promise.all([...pending]);
      return records;
    },
  };
}

function shouldDiscard(method: string, resourceType: string, url: string): boolean {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(url))) return true;
  return method === 'GET' && resourceType !== 'xhr' && resourceType !== 'fetch';
}

function sanitizeBody(
  body: string | null,
  contentType: string | undefined,
  sanitizer: ReturnType<typeof createSanitizer>,
): { value: string | null; mode: SanitizeMode } {
  if (body === null) return { value: null, mode: 'none' };
  const result = sanitizer.sanitizeBodyWithMode(body, contentType ?? '');
  return { value: result.value, mode: result.sanitizeMode };
}

function mergeSanitizeMode(left: SanitizeMode, right: SanitizeMode): SanitizeMode {
  if (left === 'fallback' || right === 'fallback') return 'fallback';
  if (left === 'structured' || right === 'structured') return 'structured';
  return 'none';
}
