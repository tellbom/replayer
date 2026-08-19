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
}

const INIT_SCRIPT_PATHS = [
  '../../locator/dist/el-locator.iife.js',
  '../../locator/dist/snapshot.iife.js',
  '../../locator/dist/selector-generator.iife.js',
] as const;

export async function launchDSHContext(options: BrowserOptions): Promise<BrowserContext> {
  const args = options.authServerAllowlist
    ? [
        `--auth-server-allowlist=${options.authServerAllowlist}`,
        `--auth-negotiate-delegate-allowlist=${options.authServerAllowlist}`,
      ]
    : [];
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
  return context;
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
