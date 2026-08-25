import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext, type Page } from 'playwright';

import { TIMEOUTS } from '@dsh/core';

export interface BrowserOptions {
  profileDir: string;
  channel?: 'chrome' | 'msedge';
  executablePath?: string;
  headless?: boolean;
  proxy?: { server: string; bypass?: string };
  authServerAllowlist?: string;
  clientCertificates?: Array<{ origin: string; pfxPath: string; passphrase?: string }>;
  timeoutMs?: number;
  args?: string[];
}

export interface BrowserLease {
  context: BrowserContext;
  release(): Promise<void>;
}

const INIT_SCRIPT_PATHS = [
  '../../locator/dist/el-locator.iife.js',
  '../../locator/dist/snapshot.iife.js',
  '../../locator/dist/pw-selector-generator.iife.js',
  '../../locator/dist/mutation-tracker.iife.js',
  '../../locator/dist/ancestor-scope.iife.js',
  '../../locator/dist/visible-hint.iife.js',
] as const;

export async function launchDSHContext(options: BrowserOptions): Promise<BrowserContext> {
  const authArgs = options.authServerAllowlist
    ? [
        `--auth-server-allowlist=${options.authServerAllowlist}`,
        `--auth-negotiate-delegate-allowlist=${options.authServerAllowlist}`,
      ]
    : [];
  const args = [...authArgs, ...(options.args ?? [])];
  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: options.channel ?? 'chrome',
    executablePath: options.executablePath,
    headless: options.headless ?? false,
    proxy: options.proxy,
    clientCertificates: options.clientCertificates,
    timeout: options.timeoutMs,
    args,
  });

  await installRuntime(context, false);
  const auditPage = await context.newPage();
  try {
    await assertRuntimeInjected(auditPage);
  } finally {
    await auditPage.close();
  }
  return context;
}

export async function acquireDSHContext(
  options: BrowserOptions,
  cdpEndpoint?: string,
): Promise<BrowserLease> {
  if (cdpEndpoint) {
    try {
      const browser = await chromium.connectOverCDP(cdpEndpoint);
      const context = browser.contexts()[0];
      if (!context) throw new Error(`CDP 会话没有默认 context: ${cdpEndpoint}`);
      await installRuntime(context, true);
      return { context, release: () => browser.close() };
    } catch (error) {
      throw new Error(
        `检测到常驻会话但无法附着，未关闭现有浏览器。请修复 endpoint 或显式使用 --force-takeover（会丢失会话）：${String(error)}`,
        { cause: error },
      );
    }
  }
  try {
    const context = await launchDSHContext(options);
    return { context, release: () => context.close() };
  } catch (error) {
    if (/profile|user data|singleton|already in use/i.test(String(error))) {
      throw new Error(
        '检测到 profile 已被其他进程使用但没有可附着的 DSH endpoint；未接管该进程。请关闭该实例，或先用 dsh session start 建立可附着会话。',
        { cause: error },
      );
    }
    throw error;
  }
}

async function installRuntime(context: BrowserContext, injectExistingPages: boolean): Promise<void> {
  const scripts = await Promise.all(INIT_SCRIPT_PATHS.map(async (relativePath) => {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    return readFile(path, 'utf8');
  }));
  for (const content of scripts) await context.addInitScript({ content });
  if (!injectExistingPages) return;

  for (const page of context.pages()) {
    for (const content of scripts) await page.evaluate(content);
    await assertRuntimeInjected(page);
  }
}

async function assertRuntimeInjected(page: Page): Promise<void> {
  const injected = await page.evaluate(() => ({
    locator: typeof Reflect.get(window, '__DSH_LOCATOR__'),
    snapshot: typeof Reflect.get(window, '__DSH_SNAPSHOT__'),
    generator: typeof Reflect.get(window, '__DSH_PWGEN__'),
    mutation: typeof Reflect.get(window, '__DSH_MUTATION__'),
    ancestorScope: typeof Reflect.get(window, '__DSH_ANCESTOR_SCOPE__'),
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

/**
 * 【T-17】等待 URL 稳定：SSO 多跳跳转（302→授权→回调）在 goto 返回后仍在进行，
 * 立即 evaluate 会撞上「Execution context was destroyed」（实测踩过）。
 * 连续 navigationSettle 不变即认为跳转结束，总等待上限 navigationSettleMax。
 */
export class NavigationStabilizationError extends Error {
  constructor(public readonly observedStates: readonly string[]) {
    super(
      `navigation lifecycle 未在时限内稳定；observed=${JSON.stringify(observedStates)}；`
      + '建议使用 persistent / attached session',
    );
    this.name = 'NavigationStabilizationError';
  }
}

/**
 * 根据主 frame 的实际 navigation lifecycle 判断冷启动是否稳定。
 * trigger 在监听器安装后执行，确保 initial navigation 和后续 redirect 都进入同一观察窗口。
 */
export async function settleNavigation(
  page: Page,
  trigger?: () => Promise<unknown>,
  maxWaitMs = TIMEOUTS.navigationSettleMax,
): Promise<void> {
  const startedAt = Date.now();
  let lastUrl = page.url();
  let lastChange = startedAt;
  const observedStates = [`0ms initial ${lastUrl}`];
  const observe = (kind: string, url: string): void => {
    const now = Date.now();
    observedStates.push(`${now - startedAt}ms ${kind} ${url}`);
    lastUrl = url;
    lastChange = now;
  };
  const onFrameNavigated = (frame: ReturnType<Page['mainFrame']>): void => {
    if (frame === page.mainFrame()) observe('navigated', frame.url());
  };
  page.on('framenavigated', onFrameNavigated);
  try {
    await trigger?.();
    while (Date.now() - startedAt < maxWaitMs) {
      await page.waitForTimeout(250);
      const current = page.url();
      if (current !== lastUrl) {
        observe('url-change', current);
        continue;
      }
      let ready = false;
      try {
        ready = await page.evaluate(() => document.readyState !== 'loading');
      } catch {
        lastChange = Date.now();
        continue;
      }
      if (ready && Date.now() - lastChange >= TIMEOUTS.navigationSettle) return;
    }
    throw new NavigationStabilizationError(observedStates);
  } finally {
    page.off('framenavigated', onFrameNavigated);
  }
}
