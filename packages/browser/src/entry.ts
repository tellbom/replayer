import { TIMEOUTS } from '@dsh/core';
import type { AuthState, Entry } from '@dsh/core';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';

import { ensureLoggedIn, entryToAuthConfig } from './auth.js';
import { settleNavigation } from './context.js';

export interface EntrySession {
  authState: AuthState;
  /** 【C21】身份摘要（sha256），诊断包只落摘要不落原值 */
  identityDigest: string;
  /** true = 会话已存在，未重走门户 */
  reused: boolean;
}

/**
 * 【T-56】建立到目标系统的会话。这是导航层面的载体动作：
 * 复用已有会话，或经门户入口链接进入子系统。本函数不包含任何登录表单
 * 填写、凭证提交或 token 换取（C16/C17）——需要用户登录时只等待。
 */
export async function ensureEntry(page: Page, entry: Entry): Promise<EntrySession> {
  // 1. 已有会话且已落地 → 直接复用（浏览器刚打开时还在 about:blank，无从复用）
  const canReuse =
    /^https?:/.test(page.url()) &&
    (await probeSession(page, entry)) &&
    urlMatches(page.url(), entry.entry.landingUrlPattern);
  if (canReuse) {
    return {
      authState: 'authenticated',
      identityDigest: await readIdentityDigest(page, entry),
      reused: true,
    };
  }

  // 2. 经 direct/portal 进入
  if (entry.entry.via === 'direct') {
    await page.goto(entry.entry.directUrl ?? entry.entry.landingUrlPattern);
    await settleNavigation(page);
  } else {
    await enterViaPortal(page, entry);
  }

  // 【C19】等待通过一次性认证跳转（只等待，不记录、不重放）
  await waitForLanding(page, entry);

  // 3. 会话确认
  const authState = (await probeSession(page, entry)) ? 'authenticated' : 'unauthenticated';
  if (authState === 'unauthenticated') {
    // 门户/子系统要求登录：等待用户完成，不代替用户登录
    await ensureLoggedIn(page, entryToAuthConfig(entry));
  }

  // 4. 身份摘要
  return { authState, identityDigest: await readIdentityDigest(page, entry), reused: false };
}

async function enterViaPortal(page: Page, entry: Entry): Promise<void> {
  await page.goto(entry.entry.portalUrl ?? '');
  await settleNavigation(page);
  const linkText = entry.entry.linkText;
  if (!linkText) throw new Error('via=portal 需要 entry.linkText');
  const link = page.locator('a', { hasText: linkText }).first();
  await link.waitFor({ state: 'visible', timeout: TIMEOUTS.entryProbe });
  await link.click();
  await settleNavigation(page);
}

/** 【C19】落地页可能经过一次性 token 跳转；等待 URL 最终命中 landingUrlPattern。 */
async function waitForLanding(page: Page, entry: Entry): Promise<void> {
  const deadline = Date.now() + TIMEOUTS.navigation;
  while (Date.now() < deadline) {
    if (urlMatches(page.url(), entry.entry.landingUrlPattern)) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`等待落地页超时: ${entry.entry.landingUrlPattern}`);
}

function urlMatches(url: string, pattern: string): boolean {
  return url.includes(pattern.replaceAll('\\', ''));
}

export async function probeSession(page: Page, entry: Entry): Promise<boolean> {
  const probe = entry.entry.sessionProbe;
  const result = await page.evaluate(
    async ({ url, okStatus }) => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        return { status: response.status };
      } catch {
        return { status: 0 };
      }
    },
    { url: new URL(probe.url, page.url()).href, okStatus: probe.okStatus },
  );
  return probe.okStatus.includes(result.status);
}

/** 【C21】身份摘要：只取 identityProbe 指定的标识字段，立即摘要，不保留原值。 */
export async function readIdentityDigest(page: Page, entry: Entry): Promise<string> {
  const probe = entry.entry.identityProbe;
  const raw = await page.evaluate(
    async ({ url, jsonPath }) => {
      try {
        const response = await fetch(url, { credentials: 'include' });
        if (!response.ok) return null;
        const body: unknown = await response.json();
        const segments = jsonPath.replace(/^\$\.?/, '').split('.').filter(Boolean);
        let current = body;
        for (const segment of segments) {
          if (typeof current !== 'object' || current === null) return null;
          current = (current as Record<string, unknown>)[segment];
        }
        return current === undefined ? null : String(current);
      } catch {
        return null;
      }
    },
    { url: new URL(probe.url, page.url()).href, jsonPath: probe.jsonPath },
  );
  if (raw === null) {
    throw new Error(`identityProbe 无法取得身份标识: ${probe.url} ${probe.jsonPath}`);
  }
  return createHash('sha256').update(raw).digest('hex');
}
