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

  for (const relativePath of INIT_SCRIPT_PATHS) {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    await context.addInitScript({ content: await readFile(path, 'utf8') });
  }
  const auditPage = await context.newPage();
  try {
    const injected = await auditPage.evaluate(() => ({
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
    const browser = await chromium.connectOverCDP(cdpEndpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error(`CDP 会话没有默认 context: ${cdpEndpoint}`);
    return { context, release: () => browser.close() };
  }
  const context = await launchDSHContext(options);
  return { context, release: () => context.close() };
}

/**
 * 【T-17】等待 URL 稳定：SSO 多跳跳转（302→授权→回调）在 goto 返回后仍在进行，
 * 立即 evaluate 会撞上「Execution context was destroyed」（实测踩过）。
 * 连续 navigationSettle 不变即认为跳转结束，总等待上限 navigationSettleMax。
 */
export async function settleNavigation(page: Page): Promise<void> {
  let lastUrl = page.url();
  let lastChange = Date.now();
  const startedAt = lastChange;
  while (Date.now() - startedAt < TIMEOUTS.navigationSettleMax) {
    await page.waitForTimeout(250);
    const current = page.url();
    if (current !== lastUrl) {
      lastUrl = current;
      lastChange = Date.now();
      continue;
    }
    if (Date.now() - lastChange >= TIMEOUTS.navigationSettle) return;
  }
}
