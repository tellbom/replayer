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
}

/**
 * 启动持久化浏览器并将一次完整录制写入 record.json。
 * 【C16】ensureEntry 完成后才开启录制——登录/门户跳转绝不进入技能。
 * 【C19】命中 excludeUrlPatterns 的导航与请求一律不记录。
 */
export async function record(opts: RecordOptions): Promise<RecordSession> {
  await mkdir(opts.profileDir, { recursive: true });
  await mkdir(opts.outDir, { recursive: true });
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
  await page.exposeBinding('__DSH_RECORD__', (_source, action: RecordedAction) => {
    // 【C19】一次性认证跳转不记录
    const actionUrl = action.url ?? '';
    if (actionUrl && excludeMatchers.some((re) => re.test(actionUrl))) return;
    actions.push(action);
  });
  await installRecorderProbe(context, page);
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

async function installRecorderProbe(context: BrowserContext, page: Page): Promise<void> {
  const probePath = fileURLToPath(
    new URL('../../locator/dist/recorder-probe.iife.js', import.meta.url),
  );
  const probe = await readFile(probePath, 'utf8');
  await context.addInitScript(() => Reflect.set(window, '__DSH_RECORDING__', true));
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
  await page.addScriptTag({ content: probe });
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
