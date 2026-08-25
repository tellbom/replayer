import { acquireDSHContext, ensureEntry, probeSession, settleNavigation } from '@dsh/browser';
import type { Entry } from '@dsh/core';
import type { RecordSession, RecordedAction, RecordedFormState, SessionInterrupt } from '@dsh/core';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserContext, Page } from 'playwright';

import { startNetworkRecording } from './network.js';

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

  const actions: RecordedAction[] = [...(opts.resumeSession?.actions ?? [])];
  const initialFormState: RecordedFormState[] = [...(opts.resumeSession?.initialFormState ?? [])];
  const interruptions: SessionInterrupt[] = [...(opts.resumeSession?.interruptions ?? [])];
  let recordingEnabled = true;
  const actionByIdx = new Map<number, RecordedAction>();
  const mutationTasks = new Map<number, Promise<void>>();
  const postProcessTasks: Promise<void>[] = [];
  await page.exposeBinding(
    '__DSH_RECORD__',
    async (_source, emitted: RecordedAction & { actionIdx: number }) => {
      if (!recordingEnabled) return;
      const { actionIdx, ...action } = emitted;
      // 【C19】一次性认证跳转不记录
      const actionUrl = action.url ?? '';
      if (actionUrl && excludeMatchers.some((re) => re.test(actionUrl))) return;
      actions.push(action);
      actionByIdx.set(actionIdx, action);
      const target = action.target as { strategy?: string; confidence?: string } | undefined;
      if (target) {
        const mutationTask = tolerateNavigation(page, () => page.evaluate(async (idx) => {
          await window.__DSH_MUTATION__.end(idx);
        }, actionIdx)).then(() => undefined);
        mutationTasks.set(actionIdx, mutationTask);
      }

      const task = (async () => {
        if (target) {
          const producerActionIdx = actionIdx - 1;
          const producerMutation = mutationTasks.get(producerActionIdx);
          if (producerMutation) {
            await producerMutation;
            const scoped = await tolerateNavigation(page, () => page.evaluate(
              ({ producerIdx, currentIdx }) => {
                const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
                const current = clicked?.[currentIdx];
                if (!current?.isConnected) return null;
                return window.__DSH_MUTATION__.deriveScope(producerIdx, current);
              },
              { producerIdx: producerActionIdx, currentIdx: actionIdx },
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
          const promoted = await promoteByAncestor(page, actionIdx);
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
            }, actionIdx));
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
              }, actionIdx),
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
  await page.exposeBinding('__DSH_RECORD_INITIAL_STATE__', (_source, state: RecordedFormState) => {
    initialFormState.push(state);
  });
  const reinjectRecorderProbe = await installRecorderProbe(page);
  const startedAt = opts.resumeSession?.meta.startedAt ?? new Date().toISOString();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const pages: RecordSession['pages'] = [
    ...(opts.resumeSession?.pages ?? []),
    { ts: Date.now(), url: page.url(), title: await page.title() },
  ];
  const pageTasks = new Set<Promise<void>>();
  const onDomContentLoaded = (): void => {
    const task = page.title().then((title) => {
      if (recordingEnabled && !excludeMatchers.some((re) => re.test(page.url()))) {
        pages.push({ ts: Date.now(), url: page.url(), title });
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
      initialFormState,
      network: [...previousNetwork, ...networkRecording.records],
      pages,
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
  await partialWrite;
  page.off('domcontentloaded', onDomContentLoaded);
  await Promise.all([...pageTasks]);
  await Promise.all([...mutationTasks.values()]);
  await Promise.all(postProcessTasks);
  const network = [...previousNetwork, ...await networkRecording.stop()];
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
    ...(initialFormState.length > 0 ? { initialFormState } : {}),
    network,
    pages,
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
    for (const item of document.querySelectorAll<HTMLElement>('.el-form-item')) {
      const label = item.querySelector<HTMLElement>('.el-form-item__label')?.textContent?.trim();
      if (!label) continue;
      const control = item.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
        'input, textarea, select',
      );
      if (!control || !expected.has(control.value.trim())) continue;
      const kind =
        control instanceof HTMLTextAreaElement
          ? 'textarea'
          : control instanceof HTMLSelectElement
            ? 'select'
            : 'input';
      return { strategy: 'el-form-item' as const, label, kind };
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
  initialFormState: RecordedFormState[];
  network: RecordSession['network'];
  pages: RecordSession['pages'];
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
    actions: input.actions,
    ...(input.initialFormState.length > 0 ? { initialFormState: input.initialFormState } : {}),
    network: input.network,
    pages: input.pages,
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
): Promise<() => Promise<void>> {
  const probePath = fileURLToPath(
    new URL('../../locator/dist/recorder-probe.iife.js', import.meta.url),
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
  const terminal = new Promise<void>((resolve) => {
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    readline.question('按 Enter 结束录制...\n', () => {
      readline.close();
      resolve();
    });
  });
  return Promise.race([
    terminal,
    page.waitForEvent('close').then(() => undefined),
    context.waitForEvent('close').then(() => undefined),
  ]);
}
