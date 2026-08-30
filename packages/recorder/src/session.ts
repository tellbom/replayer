import { acquireDSHContext, ensureEntry, probeSession, settleNavigation } from '@dsh/browser';
import { CANONICAL_CAPTURE, ENUM_CAPTURE, createSanitizer } from '@dsh/core';
import type { ActiveAction, CanonicalAction, Entry } from '@dsh/core';
import type {
  PageSnapshot, RecordSession, RecordedAction, RecordedFormState, RecordedRequest, SessionInterrupt,
} from '@dsh/core';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext, Page } from 'playwright';

import { startNetworkRecording } from './network.js';
import { finalizeCanonicalActions } from './canonical.js';

export interface RecordOptions {
  /** 【v2.0】entry 配置：录制起点恒为已建立的子系统会话（C16） */
  entry: Entry;
  profileDir: string;
  outDir: string;
  channel?: 'chrome' | 'msedge';
  headless?: boolean;
  cdpEndpoint?: string;
  stopSignal?: Promise<void>;
  onReady?: (page: Page) => Promise<void>;
  /** 从 CLI 已确认的 partial 快照继续；登录与身份仍重新校验。 */
  resumeSession?: RecordSession;
  recorderPath?: 'legacy' | 'canonical';
  /**
   * 【T-67b】录制期消歧回调。playwright 引擎产物为 LOW（位置依赖）时触发，
   * 传入页面、原元素句柄与局部上下文；回调返回经 Playwright 再验证的
   * scoped selector（count==1 且命中原元素），否则 null 保持原产物。
   */
  onDisambiguation?: (input: {
    page: Page;
    /** 用户真实点击的元素（录制 oracle，仅本次回调内有效） */
    targetElement: unknown;
    /** playwright 引擎低置信产物 */
    pwResult: { selector: string; matchCount: number; confidence: 'HIGH' | 'LOW' };
    /** 浏览器侧 __DSH_DISAMBIG__ 局部上下文 */
    context: {
      target: {
        tag: string;
        role: string | null;
        text: string;
        type: string | null;
        name: string | null;
        placeholder: string | null;
      };
      ancestors: Array<{
        tag: string;
        role: string | null;
        heading: string | null;
        sameNameCount: number;
      }>;
      siblings: Array<{ role: string | null; text: string; type: string | null }>;
      sameNameCandidates: Array<{ index: number; nearestHeading: string | null }>;
    };
  }) => Promise<string | null>;
}

/**
 * 启动持久化浏览器并将一次完整录制写入 record.json。
 * 【C16】ensureEntry 完成后才开启录制——登录/门户跳转绝不进入技能。
 * 【C19】命中 excludeUrlPatterns 的导航与请求一律不记录。
 */
export async function record(opts: RecordOptions): Promise<RecordSession> {
  await mkdir(opts.profileDir, { recursive: true });
  await mkdir(opts.outDir, { recursive: true });
  const lease = await acquireDSHContext(
    {
      profileDir: opts.profileDir,
      channel: opts.channel,
      headless: opts.headless,
    },
    opts.cdpEndpoint,
  );
  const context = lease.context;
  const page = context.pages()[0] ?? (await context.newPage());
  const excludeMatchers = compileExcludePatterns(opts.entry.entry.excludeUrlPatterns);

  // 【C16】先建立会话，再开录制
  const entrySession = await ensureEntry(page, opts.entry);
  const baseUrl = new URL(page.url()).origin;

  const recorderPath = opts.recorderPath ?? 'canonical';
  const actions: RecordedAction[] = recorderPath === 'legacy' ? [...(opts.resumeSession?.actions ?? [])] : [];
  const canonicalActions: CanonicalAction[] = recorderPath === 'canonical'
    ? [...(opts.resumeSession?.canonicalActions ?? [])]
    : [];
  const canonicalActionByIdx = new Map(canonicalActions.map((action) => [action.actionIdx, action]));
  const initialFormState: RecordedFormState[] = [...(opts.resumeSession?.initialFormState ?? [])];
  const pageSnapshots: PageSnapshot[] = [...(opts.resumeSession?.pageSnapshots ?? [])];
  const interruptions: SessionInterrupt[] = [...(opts.resumeSession?.interruptions ?? [])];
  let recordingEnabled = true;
  const actionByIdx = new Map<number, RecordedAction>();
  const browserActionKeys = new Map<string, number>();
  const latestBrowserActions = new Map<number, number>();
  const canonicalToBrowserAction = new Map<number, number>();
  let nextCanonicalActionIdx = actions.length;
  let activeAction: ActiveAction | null = null;
  const resolveCanonicalActionIndex = (
    browserActionIdx: number,
    activeStartedAt?: number,
  ): number => {
    const key = activeStartedAt === undefined
      ? undefined
      : `${browserActionIdx}:${activeStartedAt}`;
    const known = key === undefined
      ? latestBrowserActions.get(browserActionIdx)
      : browserActionKeys.get(key);
    if (known !== undefined) return known;
    const canonical = nextCanonicalActionIdx++;
    if (key !== undefined) browserActionKeys.set(key, canonical);
    latestBrowserActions.set(browserActionIdx, canonical);
    canonicalToBrowserAction.set(canonical, browserActionIdx);
    return canonical;
  };
  const mutationTasks = new Map<number, Promise<void>>();
  const postProcessTasks: Promise<void>[] = [];
  const sanitizer = createSanitizer(opts.entry.entry.additionalSensitivePatterns ?? []);
  await page.exposeBinding(
    '__DSH_RECORD__',
    async (
      _source,
      emitted: RecordedAction & { actionIdx: number; activeStartedAt?: number },
    ) => {
      if (!recordingEnabled) return;
      const { actionIdx: browserActionIdx, activeStartedAt, ...action } = emitted;
      if (action.enumOptions) {
        action.enumOptions = {
          ...action.enumOptions,
          items: action.enumOptions.items.map((item) => ({
            label: sanitizer.sanitizeText(item.label),
            value: sanitizer.sanitizeText(item.value),
          })),
        };
      }
      // 【C19】一次性认证跳转不记录
      const actionUrl = action.url ?? '';
      if (actionUrl && excludeMatchers.some((re) => re.test(actionUrl))) return;
      if (action.type === 'navigate') {
        browserActionKeys.clear();
        latestBrowserActions.clear();
      }
      const actionIdx = resolveCanonicalActionIndex(browserActionIdx, activeStartedAt);
      const existingAction = actionByIdx.get(actionIdx);
      if (existingAction) {
        Object.assign(existingAction, action);
        return;
      }
      actions.push(action);
      actionByIdx.set(actionIdx, action);
      const target = action.target as { strategy?: string; confidence?: string } | undefined;
      if (target) {
        const mutationTask = tolerateNavigation(page, () => page.evaluate(async (idx) => {
          await window.__DSH_MUTATION__.end(idx);
        }, browserActionIdx)).then(() => undefined);
        mutationTasks.set(actionIdx, mutationTask);
      }

      const task = (async () => {
        if (target) {
          const producerActionIdx = actionIdx - 1;
          const producerMutation = mutationTasks.get(producerActionIdx);
          const producerBrowserActionIdx = canonicalToBrowserAction.get(producerActionIdx);
          if (producerMutation) {
            await producerMutation;
            if (producerBrowserActionIdx === undefined) return;
            const scoped = await tolerateNavigation(page, () => page.evaluate(
              ({ producerIdx, currentIdx }) => {
                const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
                const current = clicked?.[currentIdx];
                if (!current?.isConnected) return null;
                return window.__DSH_MUTATION__.deriveScope(producerIdx, current);
              },
              { producerIdx: producerBrowserActionIdx, currentIdx: browserActionIdx },
            ));
            if (scoped) {
              const scopeId = `sc${producerActionIdx + 1}`;
              const producer = actionByIdx.get(producerActionIdx)!;
              producer.produces = {
                scopeId,
                root: scoped.root.descriptor,
                kind: scoped.root.kind,
                portaled: scoped.root.portaled,
                appearedAfterMs: scoped.root.appearedAfterMs,
              };
              producer.waitAfter = { scopeReady: scopeId, settleMs: 200, timeoutMs: 8_000 };
              action.scope = scopeId;
              action.target = scoped.target;
              return;
            }
          }
        }

        if (target?.strategy === 'playwright' && target.confidence === 'LOW') {
          const promoted = await promoteByAncestor(page, browserActionIdx);
          if (promoted) {
            action.target = {
              strategy: 'playwright',
              selector: `${promoted.scopeSelector} >> ${promoted.targetSelector}`,
              confidence: 'HIGH',
            };
            return;
          }
        }

        // 【T-67b】scope 规则未命中后，LOW 才进入 LLM 消歧。
        if (
          opts.onDisambiguation &&
          target?.strategy === 'playwright' &&
          target.confidence === 'LOW'
        ) {
          try {
            const disambig = await tolerateNavigation(page, () => page.evaluate((idx) => {
              const collect = Reflect.get(window, '__DSH_DISAMBIG__');
              const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
              const el = clicked[idx];
              if (typeof collect !== 'function' || !el) return null;
              return { context: collect(el) };
            }, browserActionIdx));
            const pwResult = {
              selector: (target as { selector: string }).selector,
              matchCount: -1,
              confidence: 'LOW' as const,
            };
            if (!disambig) return;
            const scoped = await opts.onDisambiguation!({
              page,
              targetElement: await page.evaluateHandle((idx) => {
                const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
                return clicked[idx];
              }, browserActionIdx),
              pwResult,
              context: disambig.context,
            });
            if (scoped) {
              action.target = {
                strategy: 'playwright',
                selector: scoped,
                confidence: 'HIGH',
              } as never;
            }
          } catch {
            // 消歧失败保持原 LOW 产物——回放期 heal 仍可兜底
          }
        }
      })();
      postProcessTasks.push(task);
      if (actions.length % 5 === 0) void persistPartial('periodic-action-checkpoint');
    },
  );
  await page.exposeBinding(
    '__DSH_ACTIVE_ACTION_UPDATE__',
    (_source, snapshot: ActiveAction | null) => {
      activeAction = snapshot === null
        ? null
        : {
            ...snapshot,
            actionIdx: resolveCanonicalActionIndex(snapshot.actionIdx, snapshot.startedAt),
          };
    },
  );
  await page.exposeBinding(
    '__DSH_CANONICAL_RECORD__',
    (_source, emitted: CanonicalAction) => {
      if (!recordingEnabled || recorderPath !== 'canonical') return;
      if (emitted.kind === 'navigate') {
        browserActionKeys.clear();
        latestBrowserActions.clear();
      }
      const actionIdx = resolveCanonicalActionIndex(emitted.actionIdx, emitted.timestamp);
      const normalized = { ...emitted, actionIdx, id: `a${actionIdx}-${emitted.timestamp}` };
      const existing = canonicalActionByIdx.get(actionIdx);
      if (existing) Object.assign(existing, normalized);
      else {
        canonicalActions.push(normalized);
        canonicalActionByIdx.set(actionIdx, normalized);
      }
    },
  );
  await page.exposeBinding('__DSH_RECORD_INITIAL_STATE__', (_source, state: RecordedFormState) => {
    initialFormState.push(state);
  });
  const reinjectRecorderProbe = await installRecorderProbe(page, recorderPath);
  const startedAt = opts.resumeSession?.meta.startedAt ?? new Date().toISOString();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const pageCandidatePools: PageSnapshot[] = [];
  const pages: RecordSession['pages'] = [
    ...(opts.resumeSession?.pages ?? []),
    { ts: Date.now(), url: page.url(), title: await page.title() },
  ];
  const pageTasks = new Set<Promise<void>>();
  const onDomContentLoaded = (): void => {
    const task = Promise.all([page.title(), collectPageCandidates(page)]).then(([title, candidates]) => {
      if (recordingEnabled && !excludeMatchers.some((re) => re.test(page.url()))) {
        const ts = Date.now();
        const url = page.url();
        pages.push({ ts, url, title });
        pageCandidatePools.push({
          ts,
          url,
          actionIdx: latestNavigationActionIndex(actions, canonicalActions, recorderPath, url, ts),
          immutableValues: candidates.map((candidate) => ({
            locator: candidate.locator,
            value: sanitizePageValue(sanitizer, candidate.key, candidate.value),
            kind: candidate.kind,
          })),
        });
      }
    }).catch(() => undefined);
    pageTasks.add(task);
    void task.finally(() => pageTasks.delete(task));
  };
  page.on('domcontentloaded', onDomContentLoaded);
  const probeMatchers = [opts.entry.entry.sessionProbe.url, opts.entry.entry.identityProbe.url].map(
    (url) => new RegExp(escapeRegExp(new URL(url, baseUrl).href)),
  );
  const previousNetwork = [...(opts.resumeSession?.network ?? [])];
  let partialWrite = Promise.resolve();
  const persistPartial = (reason: string, identityChanged = false): Promise<void> => {
    partialWrite = partialWrite.then(() => writePartialSnapshot({
      outputPath: `${opts.outDir}/record.partial.json`,
      startedAt,
      baseUrl,
      userAgent,
      entryId: opts.entry.entry.id,
      actions,
      canonicalActions,
      recorderPath,
      initialFormState,
      network: [...previousNetwork, ...networkRecording.records],
      pages,
      pageSnapshots,
      interruptions,
      reason,
      identityChanged,
    }));
    return partialWrite;
  };
  const networkRecording = startNetworkRecording(
    page,
    [...excludeMatchers, ...probeMatchers],
    () => { void persistPartial('mutating-request-started'); },
    () => activeAction,
    (request) => persistConsumedPageValues(
      request, pageCandidatePools, pageSnapshots, actions, canonicalActions, recorderPath,
    ),
    sanitizer,
  );
  const partialTimer = setInterval(() => {
    void persistPartial('periodic-time-checkpoint');
  }, 10_000);
  const monitorAbort = new AbortController();
  let identityChanged = false;

  try {
    await showRecordingBar(page);
    if (opts.onReady) await opts.onReady(page);
    const monitor = monitorRecordingSession({
      page,
      entry: opts.entry,
      initialIdentityDigest: entrySession.identityDigest,
      actions,
      interruptions,
      networkRecording,
      pages,
      persistPartial,
      mutationTasks,
      postProcessTasks,
      onRecordingState(enabled) {
        recordingEnabled = enabled;
      },
      onSessionBoundary() {
        actionByIdx.clear();
        browserActionKeys.clear();
        latestBrowserActions.clear();
        canonicalToBrowserAction.clear();
        activeAction = null;
        mutationTasks.clear();
      },
      onResume: reinjectRecorderProbe,
      signal: monitorAbort.signal,
    });
    const stopSignal = opts.stopSignal ?? waitForManualStop(context, page);
    const outcome = await Promise.race([stopSignal.then(() => 'stopped' as const), monitor]);
    identityChanged = outcome === 'identityChanged';
    monitorAbort.abort();
    await monitor;
  } catch (error) {
    monitorAbort.abort();
    clearInterval(partialTimer);
    await persistPartial(error instanceof Error ? error.message : String(error));
    page.off('domcontentloaded', onDomContentLoaded);
    await Promise.allSettled([...mutationTasks.values()]);
    await Promise.allSettled(postProcessTasks);
    await networkRecording.stop();
    await lease.release();
    throw error;
  }
  clearInterval(partialTimer);
  if (recorderPath === 'canonical') {
    await tolerateNavigation(page, () => page.evaluate(async () => {
      const flush = Reflect.get(window, '__DSH_CANONICAL_FLUSH__');
      if (typeof flush === 'function') await flush();
    }));
  }
  await partialWrite;
  page.off('domcontentloaded', onDomContentLoaded);
  await Promise.all([...pageTasks]);
  await Promise.all([...mutationTasks.values()]);
  await Promise.all(postProcessTasks);
  const network = [...previousNetwork, ...await networkRecording.stop()];
  if (recorderPath === 'canonical') {
    const finalized = finalizeCanonicalActions(
      canonicalActions,
      network,
      opts.entry.entry.additionalSensitivePatterns ?? [],
    );
    canonicalActions.splice(0, canonicalActions.length, ...finalized);
  }
  await inferAsyncWaits(page, actions, network);
  const session: RecordSession = {
    meta: {
      startedAt,
      endedAt: new Date().toISOString(),
      baseUrl,
      userAgent,
      entryId: opts.entry.entry.id,
      ...(identityChanged ? { identityChanged: true } : {}),
    },
    actions,
    recorderPath,
    ...(recorderPath === 'canonical' ? { canonicalActions } : {}),
    ...(initialFormState.length > 0 ? { initialFormState } : {}),
    network,
    pages,
    ...(pageSnapshots.length > 0 ? { pageSnapshots } : {}),
    ...(interruptions.length > 0 ? { interruptions } : {}),
  };
  await writeAtomic(`${opts.outDir}/record.json`, session);
  if (!identityChanged) await rm(`${opts.outDir}/record.partial.json`, { force: true });
  await lease.release();
  void entrySession;
  return session;
}

async function inferAsyncWaits(
  page: Page,
  actions: RecordedAction[],
  network: RecordSession['network'],
): Promise<void> {
  for (const [index, action] of actions.entries()) {
    if (action.type === 'navigate') continue;
    const windowEnd = Math.min(actions[index + 1]?.ts ?? Number.POSITIVE_INFINITY, action.ts + 2_000);
    const requests = network.filter(
      (request) =>
        request.requestTs >= action.ts &&
        request.requestTs < windowEnd &&
        (request.resourceType === 'xhr' || request.resourceType === 'fetch') &&
        request.status !== null &&
        request.status >= 200 &&
        request.status < 300 &&
        request.responseBody !== null,
    );

    for (const request of requests) {
      const values = responseScalarValues(request.responseBody!);
      if (values.length === 0) continue;
      const notEmpty = await findPopulatedFormControl(page, values);
      if (!notEmpty) continue;
      const requestUrl = new URL(request.url);
      action.waitAfter = {
        ...action.waitAfter,
        requestUrlPattern: requestUrl.pathname,
        notEmpty,
        timeoutMs: action.waitAfter?.timeoutMs ?? 8_000,
      };
      break;
    }
  }
}

interface PageValueCandidate {
  locator: PageSnapshot['immutableValues'][number]['locator'];
  value: string;
  key: string;
  kind: PageSnapshot['immutableValues'][number]['kind'];
}

async function collectPageCandidates(page: Page): Promise<PageValueCandidate[]> {
  return page.evaluate(() => {
    const quote = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const controlSelector = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string | null => {
      if (element.name) return `${element.tagName.toLowerCase()}[name="${quote(element.name)}"]`;
      if (element.id) return `#${CSS.escape(element.id)}`;
      return null;
    };
    const values: PageValueCandidate[] = [];
    for (const element of document.querySelectorAll('input[type="hidden"], input[readonly], textarea[readonly], input:disabled, textarea:disabled, select:disabled')) {
      if (!(element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement
        || element instanceof HTMLSelectElement)) continue;
      const selector = controlSelector(element);
      if (!selector || element.value === '') continue;
      values.push({
        locator: { strategy: 'css', selector },
        value: element.value,
        key: element.name || element.id,
        kind: element instanceof HTMLInputElement && element.type === 'hidden'
          ? 'hidden'
          : ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
              && element.readOnly)
            ? 'readonly'
            : 'disabled',
      });
    }
    for (const element of document.querySelectorAll('meta[content]')) {
      if (!(element instanceof HTMLMetaElement) || element.content === '') continue;
      const attribute: [string, string] | null = element.name
        ? ['name', element.name]
        : element.getAttribute('property')
          ? ['property', element.getAttribute('property')!]
          : element.httpEquiv
            ? ['http-equiv', element.httpEquiv]
            : null;
      if (!attribute) continue;
      values.push({
        locator: {
          strategy: 'css',
          selector: `meta[${attribute[0]}="${quote(attribute[1])}"]`,
        },
        value: element.content,
        key: attribute[1],
        kind: 'meta',
      });
    }
    return values;
  });
}

function sanitizePageValue(
  sanitizer: ReturnType<typeof createSanitizer>,
  key: string,
  value: string,
): string {
  const sanitized = sanitizer.sanitizeObject({ [key]: value });
  return String(sanitized[key]);
}

function persistConsumedPageValues(
  request: RecordedRequest,
  pools: PageSnapshot[],
  output: PageSnapshot[],
  actions: RecordedAction[],
  canonicalActions: CanonicalAction[],
  recorderPath: 'legacy' | 'canonical',
): void {
  const pool = [...pools]
    .filter((candidate) => candidate.ts <= request.requestTs)
    .sort((left, right) => right.ts - left.ts)[0];
  if (!pool) return;
  const requestValues = requestLeafValues(request);
  const matches = pool.immutableValues.filter((candidate) => requestValues.has(candidate.value));
  for (const match of matches) {
    if (pool.immutableValues.filter((candidate) => candidate.value === match.value).length !== 1) continue;
    let snapshot = output.find((candidate) => candidate.ts === pool.ts && candidate.url === pool.url);
    if (!snapshot) {
      snapshot = {
        ts: pool.ts,
        url: pool.url,
        actionIdx: latestNavigationActionIndex(
          actions, canonicalActions, recorderPath, pool.url, request.requestTs,
        ) ?? pool.actionIdx,
        immutableValues: [],
      };
      output.push(snapshot);
    }
    if (!snapshot.immutableValues.some((candidate) =>
      JSON.stringify(candidate.locator) === JSON.stringify(match.locator) && candidate.value === match.value,
    )) snapshot.immutableValues.push(match);
  }
}

function requestLeafValues(request: RecordedRequest): Set<string> {
  const values = new Set<string>();
  try {
    const url = new URL(request.url);
    url.searchParams.forEach((value) => values.add(value));
  } catch {
    // Invalid recorded URLs simply provide no query candidates.
  }
  if (!request.postData) return values;
  const contentType = request.headers['content-type'] ?? '';
  try {
    const body = contentType.includes('application/x-www-form-urlencoded')
      ? Object.fromEntries(new URLSearchParams(request.postData))
      : JSON.parse(request.postData) as unknown;
    collectScalarValues(body, values);
  } catch {
    // Malformed bodies are untrusted recording input and cannot prove consumption.
  }
  return values;
}

function collectScalarValues(value: unknown, output: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((item) => collectScalarValues(item, output));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach((item) => collectScalarValues(item, output));
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    output.add(String(value));
  }
}

function latestNavigationActionIndex(
  actions: RecordedAction[],
  canonicalActions: CanonicalAction[],
  recorderPath: 'legacy' | 'canonical',
  url: string,
  ts: number,
): number | null {
  if (recorderPath === 'canonical') {
    for (let index = canonicalActions.length - 1; index >= 0; index -= 1) {
      const action = canonicalActions[index]!;
      const navigationUrl = action.effects?.navigation?.url ?? action.after?.page?.url;
      if (action.kind === 'navigate' && action.timestamp <= ts && navigationUrl === url) {
        return action.actionIdx;
      }
    }
    return null;
  }
  for (let index = actions.length - 1; index >= 0; index -= 1) {
    const action = actions[index]!;
    if (action.type === 'navigate' && action.ts <= ts && action.url === url) return index;
  }
  return null;
}

function responseScalarValues(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string' || typeof value === 'number') {
      const text = String(value).trim();
      if (text) values.push(text);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(parsed);
  return values;
}

async function findPopulatedFormControl(
  page: Page,
  responseValues: string[],
): Promise<RecordedAction['target'] | null> {
  return (await tolerateNavigation(page, () => page.evaluate((values) => {
    const expected = new Set(values);
    for (const control of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    )) {
      const populated = expected.has(control.value.trim())
        || (control instanceof HTMLSelectElement && [...control.options].some((option) =>
          expected.has(option.value) || expected.has(option.textContent?.trim() ?? ''),
        ));
      if (!populated) continue;
      const generate = Reflect.get(window, '__DSH_PWGEN__');
      if (typeof generate !== 'function') return null;
      const generated = generate(control) as {
        selector: string;
        confidence: 'HIGH' | 'LOW';
      };
      return {
        strategy: 'playwright' as const,
        selector: generated.selector,
        confidence: generated.confidence,
      };
    }
    return null;
  }, responseValues))) ?? null;
}

/** excludeUrlPatterns 是「字面子串的正则写法」（默认 \\?token= 等），转成 RegExp。 */
function compileExcludePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface SessionMonitorOptions {
  page: Page;
  entry: Entry;
  initialIdentityDigest: string;
  actions: RecordedAction[];
  interruptions: SessionInterrupt[];
  networkRecording: ReturnType<typeof startNetworkRecording>;
  pages: RecordSession['pages'];
  persistPartial(reason: string, identityChanged?: boolean): Promise<void>;
  mutationTasks: Map<number, Promise<void>>;
  postProcessTasks: Promise<void>[];
  onRecordingState(enabled: boolean): void;
  onSessionBoundary(): void;
  onResume(): Promise<void>;
  signal: AbortSignal;
}

async function monitorRecordingSession(
  options: SessionMonitorOptions,
): Promise<'identityChanged' | 'stopped'> {
  let wake = deferredNavigationWake();
  const onFrameNavigated = (frame: import('playwright').Frame): void => {
    if (frame === options.page.mainFrame()) wake.resolve();
  };
  options.page.on('framenavigated', onFrameNavigated);
  try {
    while (!options.signal.aborted) {
      await Promise.race([
        delay(options.entry.entry.sessionHolding.probeIntervalMs, undefined, {
          signal: options.signal,
        }),
        wake.promise,
      ]);
      wake = deferredNavigationWake();
      if (await probeSession(options.page, options.entry)) continue;

      options.onRecordingState(false);
      options.networkRecording.setEnabled(false);
      await setRecordingState(options.page, false);
      await Promise.all([...options.mutationTasks.values()]);
      await Promise.all(options.postProcessTasks);
      options.onSessionBoundary();

      const interruption: SessionInterrupt = {
        type: 'session-interrupt',
        atActionIdx: options.actions.length,
        detectedAt: new Date().toISOString(),
      };
      options.interruptions.push(interruption);
      await options.persistPartial('session-interrupt');
      await showSessionNotice(options.page, '会话已过期，请重新登录；登录后可继续录制');

      const resumed = await ensureEntry(options.page, options.entry);
      if (resumed.identityDigest !== options.initialIdentityDigest) {
        interruption.identityChanged = true;
        await options.persistPartial('identity-changed', true);
        return 'identityChanged';
      }

      interruption.resumedAt = new Date().toISOString();
      await options.onResume();
      await setRecordingState(options.page, true);
      options.networkRecording.setEnabled(true);
      options.onRecordingState(true);
      await showSessionNotice(options.page, '会话已恢复。页面状态可能已重置，请回到中断前的位置');
    }
  } catch (error) {
    if (!options.signal.aborted) throw error;
  } finally {
    options.page.off('framenavigated', onFrameNavigated);
  }
  return 'stopped';
}

function deferredNavigationWake(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

interface PartialSnapshotInput {
  outputPath: string;
  startedAt: string;
  baseUrl: string;
  userAgent: string;
  entryId: string;
  actions: RecordedAction[];
  canonicalActions: CanonicalAction[];
  recorderPath: 'legacy' | 'canonical';
  initialFormState: RecordedFormState[];
  network: RecordSession['network'];
  pages: RecordSession['pages'];
  pageSnapshots: PageSnapshot[];
  interruptions: SessionInterrupt[];
  reason: string;
  identityChanged: boolean;
}

async function writePartialSnapshot(input: PartialSnapshotInput): Promise<void> {
  const partial = {
    meta: {
      startedAt: input.startedAt,
      endedAt: new Date().toISOString(),
      baseUrl: input.baseUrl,
      userAgent: input.userAgent,
      entryId: input.entryId,
      ...(input.identityChanged ? { identityChanged: true } : {}),
    },
    actions: input.recorderPath === 'canonical' ? [] : input.actions,
    recorderPath: input.recorderPath,
    ...(input.recorderPath === 'canonical' ? { canonicalActions: input.canonicalActions } : {}),
    ...(input.initialFormState.length > 0 ? { initialFormState: input.initialFormState } : {}),
    network: input.network,
    pages: input.pages,
    ...(input.pageSnapshots.length > 0 ? { pageSnapshots: input.pageSnapshots } : {}),
    interruptions: input.interruptions,
    incomplete: true,
    reason: input.reason,
  };
  await writeAtomic(input.outputPath, partial);
}

async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporary, path);
}

const RECORDING_PAUSED_MARKER = '__DSH_RECORDING_PAUSED__';

async function setRecordingState(page: Page, enabled: boolean): Promise<void> {
  await tolerateNavigation(page, () => page.evaluate(
    ({ active, marker }) => {
      Reflect.set(window, '__DSH_RECORDING__', active);
      const tokens = window.name.split(' ').filter((token) => token && token !== marker);
      if (!active) tokens.push(marker);
      window.name = tokens.join(' ');
    },
    { active: enabled, marker: RECORDING_PAUSED_MARKER },
  ));
}

async function showSessionNotice(page: Page, text: string): Promise<void> {
  await tolerateNavigation(page, () => page.evaluate((message) => {
    let bar = document.querySelector<HTMLDivElement>('#__dsh_recording_bar__');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__dsh_recording_bar__';
      document.body.append(bar);
    }
    bar.textContent = message;
    Object.assign(bar.style, {
      position: 'fixed',
      inset: '0 0 auto 0',
      zIndex: '2147483647',
      padding: '6px',
      color: 'white',
      background: '#d93025',
      textAlign: 'center',
    });
  }, text));
}

async function installRecorderProbe(
  page: Page,
  recorderPath: 'legacy' | 'canonical',
): Promise<() => Promise<void>> {
  const probePath = fileURLToPath(
    new URL(
      recorderPath === 'canonical'
        ? '../../locator/dist/canonical-recorder-probe.iife.js'
        : '../../locator/dist/recorder-probe.iife.js',
      import.meta.url,
    ),
  );
  const probe = await readFile(probePath, 'utf8');
  const pwgenPath = fileURLToPath(
    new URL('../../locator/dist/pw-selector-generator.iife.js', import.meta.url),
  );
  const pwgen = await readFile(pwgenPath, 'utf8');
  const disambigPath = fileURLToPath(
    new URL('../../locator/dist/disambiguation-context.iife.js', import.meta.url),
  );
  const disambig = await readFile(disambigPath, 'utf8');
  await page.addInitScript({ content: pwgen });
  await page.addInitScript({ content: disambig });
  await page.addScriptTag({ content: pwgen });
  await page.addScriptTag({ content: disambig });
  await page.addInitScript(
    (marker) => Reflect.set(window, '__DSH_RECORDING__', !window.name.split(' ').includes(marker)),
    RECORDING_PAUSED_MARKER,
  );
  await page.addInitScript(
    (maxOptions) => Reflect.set(window, '__DSH_ENUM_MAX_OPTIONS__', maxOptions),
    ENUM_CAPTURE.maxOptions,
  );
  await page.evaluate(
    (maxOptions) => Reflect.set(window, '__DSH_ENUM_MAX_OPTIONS__', maxOptions),
    ENUM_CAPTURE.maxOptions,
  );
  await page.addInitScript(
    (milliseconds) => Reflect.set(window, '__DSH_CANONICAL_SETTLE_MS__', milliseconds),
    CANONICAL_CAPTURE.mutationSettleMs,
  );
  await page.evaluate(
    (milliseconds) => Reflect.set(window, '__DSH_CANONICAL_SETTLE_MS__', milliseconds),
    CANONICAL_CAPTURE.mutationSettleMs,
  );
  for (const [name, value] of [
    ['__DSH_CANONICAL_MAX_AFFECTED__', CANONICAL_CAPTURE.maxAffected],
    ['__DSH_CANONICAL_MAX_INNER_HTML__', CANONICAL_CAPTURE.maxInnerHTMLLength],
    ['__DSH_CANONICAL_POINTER_MERGE_GRACE_MS__', CANONICAL_CAPTURE.pointerMergeGraceMs],
  ] as const) {
    await page.addInitScript(({ key, limit }) => Reflect.set(window, key, limit), { key: name, limit: value });
    await page.evaluate(({ key, limit }) => Reflect.set(window, key, limit), { key: name, limit: value });
  }
  // 注意：闭包捕获外层变量的 addInitScript 实测不生效（变量不随函数序列化），
  // 必须用参数形式传递
  const installBar = (marker: string): void => {
    window.addEventListener('DOMContentLoaded', () => {
      const bar = document.createElement('div');
      bar.id = '__dsh_recording_bar__';
      bar.textContent = window.name.split(' ').includes(marker)
        ? '会话已过期，请重新登录；登录后可继续录制'
        : 'DSH 正在录制';
      Object.assign(bar.style, {
        position: 'fixed',
        inset: '0 0 auto 0',
        zIndex: '2147483647',
        padding: '6px',
        color: 'white',
        background: '#d93025',
        textAlign: 'center',
      });
      document.body.append(bar);
    });
  };
  await page.addInitScript(installBar, RECORDING_PAUSED_MARKER);
  const guardedProbe = `if (!Reflect.get(window, '__DSH_RECORDER_PROBE_INSTALLED__')) { Reflect.set(window, '__DSH_RECORDER_PROBE_INSTALLED__', true); ${probe} }`;
  await page.addInitScript({ content: guardedProbe });
  await setRecordingState(page, true);
  const injectCurrentProbe = async (): Promise<void> => {
    await page.addScriptTag({ content: guardedProbe });
  };
  await injectCurrentProbe();
  const injected = await tolerateNavigation(page, () => page.evaluate(() => ({
    locator: typeof Reflect.get(window, '__DSH_LOCATOR__'),
    snapshot: typeof Reflect.get(window, '__DSH_SNAPSHOT__'),
    generator: typeof Reflect.get(window, '__DSH_PWGEN__'),
    mutation: typeof Reflect.get(window, '__DSH_MUTATION__'),
    ancestorScope: typeof Reflect.get(window, '__DSH_ANCESTOR_SCOPE__'),
  })));
  if (!injected) return injectCurrentProbe;
  const missing = Object.entries(injected).filter(
    ([, value]) => value === 'undefined' || value === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `[注入自检失败] ${JSON.stringify(injected)} — 缺失: ${missing.map(([name]) => name).join(',')}`,
    );
  }
  return injectCurrentProbe;
}

async function promoteByAncestor(
  page: Page,
  actionIdx: number,
): Promise<{ scopeSelector: string; targetSelector: string } | null> {
  const candidate = await tolerateNavigation(page, () => page.evaluate((idx) => {
    const derive = Reflect.get(window, '__DSH_ANCESTOR_SCOPE__') as (element: Element) => {
      scopeSelector: string;
      targetSelector: string;
      targetConfidence: 'HIGH' | 'LOW';
    } | null;
    const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
    const target = clicked?.[idx];
    if (typeof derive !== 'function' || !target?.isConnected) return null;
    return derive(target);
  }, actionIdx));
  if (!candidate || candidate.targetConfidence !== 'HIGH') return null;

  const scope = page.locator(candidate.scopeSelector);
  if ((await scope.count()) !== 1) return null;
  const target = scope.locator(candidate.targetSelector);
  if ((await target.count()) !== 1) return null;
  const handle = await target.elementHandle();
  const matchesOracle = await tolerateNavigation(page, () => page.evaluate(
    ({ element, idx }) => {
      const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
      return element === clicked[idx];
    },
    { element: handle, idx: actionIdx },
  ));
  return matchesOracle ? candidate : null;
}

async function showRecordingBar(page: Page): Promise<void> {
  await tolerateNavigation(page, () => page.evaluate(() => {
    const bar = document.createElement('div');
    bar.id = '__dsh_recording_bar__';
    bar.textContent = 'DSH 正在录制';
    Object.assign(bar.style, {
      position: 'fixed',
      inset: '0 0 auto 0',
      zIndex: '2147483647',
      padding: '6px',
      color: 'white',
      background: '#d93025',
      textAlign: 'center',
    });
    document.body.append(bar);
  }));
}

async function tolerateNavigation<T>(page: Page, operation: () => Promise<T>): Promise<T | undefined> {
  try {
    return await operation();
  } catch (error) {
    if (!isNavigationRace(error)) throw error;
    if (page.isClosed()) throw error;
    await settleNavigation(page);
    return undefined;
  }
}

function isNavigationRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /execution context was destroyed|cannot find context with specified id|navigation.*interrupted/i.test(message);
}

function waitForManualStop(context: BrowserContext, page: Page): Promise<void> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const terminal = new Promise<void>((resolve) => {
    readline.question('按 Enter 结束录制...\n', () => {
      resolve();
    });
  });
  return Promise.race([
    terminal,
    page.waitForEvent('close', { timeout: 0 }).then(() => undefined),
    context.waitForEvent('close', { timeout: 0 }).then(() => undefined),
  ]).finally(() => readline.close());
}
