import { ensureEntry, launchDSHContext } from '@dsh/browser';
import type { Entry } from '@dsh/core';
import type { RecordSession, RecordedAction } from '@dsh/core';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';

import { startNetworkRecording } from './network.js';

export interface RecordOptions {
  /** 【v2.0】entry 配置：录制起点恒为已建立的子系统会话（C16） */
  entry: Entry;
  profileDir: string;
  outDir: string;
  channel?: 'chrome' | 'msedge';
  headless?: boolean;
  stopSignal?: Promise<void>;
  onReady?: (page: Page) => Promise<void>;
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
      target: { tag: string; role: string | null; text: string; type: string | null; name: string | null; placeholder: string | null };
      ancestors: Array<{ tag: string; role: string | null; heading: string | null; sameNameCount: number }>;
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
  const engine = process.env.DSH_LOCATOR_ENGINE === 'playwright' ? 'playwright' : 'legacy';
  const context = await launchDSHContext({
    profileDir: opts.profileDir,
    channel: opts.channel,
    headless: opts.headless,
  });
  const page = context.pages()[0] ?? (await context.newPage());
  const excludeMatchers = compileExcludePatterns(opts.entry.entry.excludeUrlPatterns);

  // 【C16】先建立会话，再开录制
  const entrySession = await ensureEntry(page, opts.entry);
  const baseUrl = new URL(page.url()).origin;

  const actions: RecordedAction[] = [];
  /** 【T-67b】进行中的消歧任务（写盘前必须全部完成，保证 record.json 一致性） */
  const disambiguationTasks = new Set<Promise<void>>();
  await page.exposeBinding('__DSH_RECORD__', async (
    _source,
    emitted: RecordedAction & { actionIdx: number },
  ) => {
    const { actionIdx, ...action } = emitted;
    // 【C19】一次性认证跳转不记录
    const actionUrl = action.url ?? '';
    if (actionUrl && excludeMatchers.some((re) => re.test(actionUrl))) return;
    actions.push(action);
    // 【T-67b】LOW 置信产物触发消歧回调（回调内部含 Playwright 再验证）；
    // 异步进行，完成后原地替换该 action 的 target。
    const target = action.target as { strategy?: string; confidence?: string } | undefined;
    if (
      opts.onDisambiguation &&
      target?.strategy === 'playwright' &&
      target.confidence === 'LOW'
    ) {
      const index = actions.length - 1;
      const task = (async () => {
        try {
          const disambig = await page.evaluate((idx) => {
            const collect = Reflect.get(window, '__DSH_DISAMBIG__');
            const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
            const el = clicked[idx];
            if (typeof collect !== 'function' || !el) return null;
            return { context: collect(el) };
          }, actionIdx);
          const pwResult = {
            selector: (target as { selector: string }).selector,
            matchCount: -1,
            confidence: 'LOW' as const,
          };
          if (!disambig) return;
          const scoped = await opts.onDisambiguation!({
            page,
            targetElement: await page.evaluateHandle(
              (idx) => {
                const clicked = Reflect.get(window, '__dsh_clicked__') as Record<number, Element>;
                return clicked[idx];
              },
              actionIdx,
            ),
            pwResult,
            context: disambig.context,
          });
          if (scoped) {
            const replaced = actions[index] as RecordedAction;
            replaced.target = { strategy: 'playwright', selector: scoped, confidence: 'HIGH' } as never;
          }
        } catch {
          // 消歧失败保持原 LOW 产物——回放期 heal 仍可兜底
        }
      })();
      disambiguationTasks.add(task);
      void task.finally(() => disambiguationTasks.delete(task));
    }
  });
  await installRecorderProbe(context, page, engine);
  const startedAt = new Date().toISOString();
  const userAgent = await page.evaluate(() => navigator.userAgent);
  actions.push({ ts: Date.now(), type: 'navigate', url: page.url() });

  const pages: RecordSession['pages'] = [
    { ts: Date.now(), url: page.url(), title: await page.title() },
  ];
  const pageTasks = new Set<Promise<void>>();
  const onDomContentLoaded = (): void => {
    const task = page.title().then((title) => {
      if (!excludeMatchers.some((re) => re.test(page.url()))) {
        pages.push({ ts: Date.now(), url: page.url(), title });
      }
    });
    pageTasks.add(task);
    void task.finally(() => pageTasks.delete(task));
  };
  page.on('domcontentloaded', onDomContentLoaded);
  const networkRecording = startNetworkRecording(page, excludeMatchers);

  try {
    await showRecordingBar(page);
    if (opts.onReady) await opts.onReady(page);
    await (opts.stopSignal ?? waitForManualStop(context, page));
  } catch (error) {
    page.off('domcontentloaded', onDomContentLoaded);
    await networkRecording.stop();
    await context.close();
    throw error;
  }
  page.off('domcontentloaded', onDomContentLoaded);
  await Promise.all([...pageTasks]);
  // 【T-67b】消歧任务全部落地后再写盘（LOW→scoped 替换需在序列化前完成）
  await Promise.all([...disambiguationTasks]);
  const network = await networkRecording.stop();
  const session: RecordSession = {
    meta: {
      startedAt,
      endedAt: new Date().toISOString(),
      baseUrl,
      userAgent,
      entryId: opts.entry.entry.id,
    },
    actions,
    network,
    pages,
  };
  await writeFile(`${opts.outDir}/record.json`, `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  await context.close();
  void entrySession;
  return session;
}

/** excludeUrlPatterns 是「字面子串的正则写法」（默认 \\?token= 等），转成 RegExp。 */
function compileExcludePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern));
}

async function installRecorderProbe(
  context: BrowserContext,
  page: Page,
  engine: 'legacy' | 'playwright',
): Promise<void> {
  const probePath = fileURLToPath(
    new URL('../../locator/dist/recorder-probe.iife.js', import.meta.url),
  );
  const probe = await readFile(probePath, 'utf8');
  // 【T-63b】feature flag：legacy（默认）| playwright（vendor Codegen 算法 POC）
  if (engine === 'playwright') {
    const pwgenPath = fileURLToPath(
      new URL('../../locator/dist/pw-selector-generator.iife.js', import.meta.url),
    );
    const pwgen = await readFile(pwgenPath, 'utf8');
    // 【T-67b】消歧局部上下文收集器（LOW 时 Node 侧回调消费）
    const disambigPath = fileURLToPath(
      new URL('../../locator/dist/disambiguation-context.iife.js', import.meta.url),
    );
    const disambig = await readFile(disambigPath, 'utf8');
    await context.addInitScript({ content: pwgen });
    await context.addInitScript({ content: disambig });
    await page.addScriptTag({ content: pwgen });
    await page.addScriptTag({ content: disambig });
  }
  await context.addInitScript(() => Reflect.set(window, '__DSH_RECORDING__', true));
  // 注意：闭包捕获外层变量的 addInitScript 实测不生效（变量不随函数序列化），
  // 必须用参数形式传递
  await context.addInitScript(
    (flag) => Reflect.set(window, '__DSH_LOCATOR_ENGINE__', flag),
    engine,
  );
  await context.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
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
    });
  });
  await context.addInitScript({ content: probe });
  await page.evaluate(() => Reflect.set(window, '__DSH_RECORDING__', true));
  // 当前页注入路径：先设引擎旗帜再挂 probe（generator() 读取的是 window 旗帜，
  // 顺序颠倒会让首屏动作走错引擎分支）
  await page.evaluate((flag) => Reflect.set(window, '__DSH_LOCATOR_ENGINE__', flag), engine);
  await page.addScriptTag({ content: probe });
  const injected = await page.evaluate(() => ({
    locator: typeof Reflect.get(window, '__DSH_LOCATOR__'),
    snapshot: typeof Reflect.get(window, '__DSH_SNAPSHOT__'),
    gen: typeof Reflect.get(window, '__DSH_GEN__'),
    engine: Reflect.get(window, '__DSH_LOCATOR_ENGINE__'),
  }));
  const missing = Object.entries(injected).filter(([, value]) =>
    value === 'undefined' || value === undefined,
  );
  if (missing.length > 0) {
    throw new Error(
      `[注入自检失败] ${JSON.stringify(injected)} — 缺失: ${missing.map(([name]) => name).join(',')}`,
    );
  }
}

async function showRecordingBar(page: Page): Promise<void> {
  await page.evaluate(() => {
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
  });
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
