import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { NOISE_PATTERNS, createSanitizer } from '@dsh/core';
import type { RunResult, StepResult } from '@dsh/core';
import type { ConsoleMessage, Page, Request, Response } from 'playwright';

interface HarEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
    postData: string | null;
  };
  response: {
    status: number | null;
    headers: Record<string, string>;
    content: string | null;
  };
  error?: string;
}

export interface DiagnosticSession {
  readonly entries: HarEntry[];
  readonly consoleLines: string[];
  stop(): Promise<void>;
}

export interface DiagnosticBundleInput {
  page: Page;
  stepId: string;
  result: RunResult | StepResult | Record<string, unknown>;
  error?: unknown;
  beforeScreenshot?: Buffer;
  session: DiagnosticSession;
  llmTrace?: string;
  runsRoot?: string;
}

/** Collect replay traffic in memory so failed runs can be reconstructed safely. */
export function startDiagnosticSession(page: Page): DiagnosticSession {
  const sanitizer = createSanitizer();
  const entries: HarEntry[] = [];
  const consoleLines: string[] = [];
  const byRequest = new Map<Request, HarEntry>();
  const pending = new Set<Promise<void>>();

  const track = (task: Promise<void>): void => {
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const onRequest = (request: Request): void => {
    if (shouldDiscard(request)) return;
    const headers = request.headers();
    const contentType = headers['content-type'] ?? '';
    const postData = request.postData();
    const entry: HarEntry = {
      startedDateTime: new Date().toISOString(),
      request: {
        method: request.method(),
        url: sanitizer.sanitizeUrl(request.url()),
        headers: sanitizer.sanitizeHeaders(headers),
        postData: postData === null ? null : sanitizer.sanitizeBody(postData, contentType),
      },
      response: { status: null, headers: {}, content: null },
    };
    entries.push(entry);
    byRequest.set(request, entry);
  };
  const onResponse = (response: Response): void => {
    const entry = byRequest.get(response.request());
    if (!entry) return;
    track(
      Promise.all([
        response.request().allHeaders(),
        response.allHeaders(),
        response.text().catch(() => null),
      ]).then(
        ([requestHeaders, headers, body]) => {
          entry.request.headers = sanitizer.sanitizeHeaders(requestHeaders);
          entry.response.status = response.status();
          entry.response.headers = sanitizer.sanitizeHeaders(headers);
          entry.response.content =
            body === null ? null : sanitizer.sanitizeBody(body, headers['content-type'] ?? '');
        },
      ),
    );
  };
  const onRequestFailed = (request: Request): void => {
    const entry = byRequest.get(request);
    if (entry) entry.error = sanitizer.sanitizeText(request.failure()?.errorText ?? 'request failed');
  };
  const onConsole = (message: ConsoleMessage): void => {
    consoleLines.push(`${message.type()}: ${message.text()}`);
  };

  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfailed', onRequestFailed);
  page.on('console', onConsole);
  return {
    entries,
    consoleLines,
    async stop() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfailed', onRequestFailed);
      page.off('console', onConsole);
      await Promise.all([...pending]);
    },
  };
}

/** Write the complete eight-file diagnostic bundle after sanitizing every textual artifact. */
export async function writeDiagnosticBundle(input: DiagnosticBundleInput): Promise<string> {
  await input.session.stop();
  const sanitizer = createSanitizer();
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const directory = join(input.runsRoot ?? join(process.cwd(), 'runs'), timestamp);
  await mkdir(directory, { recursive: true });

  const afterScreenshot = await input.page.screenshot();
  const beforeScreenshot = input.beforeScreenshot ?? afterScreenshot;
  const dom = sanitizer.sanitizeText(
    sanitizer.sanitizeBody(await input.page.content(), 'text/html'),
  );
  const snapshot = sanitizer.sanitizeText(
    await input.page.evaluate(() =>
      typeof window.__DSH_SNAPSHOT__ === 'function' ? window.__DSH_SNAPSHOT__() : '',
    ),
  );
  const result = sanitizer.sanitizeText(
    // StepResult.raw.text 等字段持有「字符串形式的响应体」，其内部 JSON 里的
    // access_token 等敏感字段不会被 sanitizeObject 的按键名匹配捕获；
    // 先序列化再按 application/json 走结构化脱敏，嵌套字符串同样被处理。
    sanitizer.sanitizeBody(
      JSON.stringify(
        sanitizer.sanitizeObject({
          result: input.result,
          error: input.error instanceof Error ? input.error.message : String(input.error ?? ''),
        }),
        null,
        2,
      ),
      'application/json',
    ),
  );
  const har = sanitizer.sanitizeText(
    JSON.stringify(
      sanitizer.sanitizeObject({
        log: {
          version: '1.2',
          creator: { name: 'dsh-replayer', version: '0.0.0' },
          entries: input.session.entries,
        },
      }),
      null,
      2,
    ),
  );
  const consoleText = sanitizer.sanitizeText(input.session.consoleLines.join('\n'));
  const llmTrace = sanitizer.sanitizeText(input.llmTrace ?? '');
  const prefix = `step-${safeName(input.stepId)}`;

  await Promise.all([
    writeFile(join(directory, 'result.json'), `${result}\n`, 'utf8'),
    writeFile(join(directory, `${prefix}-before.png`), beforeScreenshot),
    writeFile(join(directory, `${prefix}-after.png`), afterScreenshot),
    writeFile(join(directory, `${prefix}-dom.html`), dom, 'utf8'),
    writeFile(join(directory, `${prefix}-snapshot.txt`), snapshot, 'utf8'),
    writeFile(join(directory, 'network.har'), `${har}\n`, 'utf8'),
    writeFile(join(directory, 'console.log'), consoleText, 'utf8'),
    writeFile(join(directory, 'llm-trace.jsonl'), llmTrace, 'utf8'),
  ]);
  return directory;
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function shouldDiscard(request: Request): boolean {
  if (NOISE_PATTERNS.some((pattern) => pattern.test(request.url()))) return true;
  return !['document', 'xhr', 'fetch'].includes(request.resourceType());
}
