import { TIMEOUTS } from '@dsh/core';
import type { AuthState, Entry } from '@dsh/core';
import { createHash } from 'node:crypto';
import type { Page } from 'playwright';

import { ensureLoggedIn, entryToAuthConfig } from './auth.js';
import { getLiveAuthHeader } from './bearer.js';
import { settleNavigation } from './context.js';
import { requestProbe } from './probe-request.js';

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
  const portalUrl = entry.entry.portalUrl ?? '';
  const linkText = entry.entry.linkText;
  if (!linkText) throw new Error('via=portal 需要 entry.linkText');
  const link = page.locator('a', { hasText: linkText }).first();

  await page.goto(portalUrl);
  await settleNavigation(page);
  try {
    await link.waitFor({ state: 'visible', timeout: TIMEOUTS.entryProbe });
  } catch {
    // 门户未登录：部分门户会把 401 重定向到自身登录页（当前页面可能已不在门户）。
    // 等待用户完成认证后，重新回到门户页找入口链接。
    await ensureLoggedIn(page, entryToAuthConfig(entry));
    await page.goto(portalUrl);
    await settleNavigation(page);
    await link.waitFor({ state: 'visible', timeout: TIMEOUTS.entryProbe });
  }
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
  return (await probeEntryAuthState(page, entry)) === 'authenticated';
}

/** 基于 HTTP 状态、结构化值与登录页证据判定；不依赖端点名或认证产品。 */
export async function probeEntryAuthState(page: Page, entry: Entry): Promise<AuthState> {
  const probe = entry.entry.sessionProbe;
  const result = await requestProbe(page, {
    url: new URL(probe.url, page.url()).href,
    jsonPath: probe.jsonPath,
    authorization: await liveAuthorization(page, entry),
  });
  if (result.status === 401) return 'unauthenticated';
  if (result.status === 403) return 'forbidden';
  if (!probe.okStatus.includes(result.status)) return 'unknown';
  if (result.format !== 'json') {
    return result.format === 'text' && matchesLoginEvidence(result.text, entry.entry.loginDomMarkers)
      ? 'unauthenticated'
      : 'unknown';
  }
  // 配置了 jsonPath 时按布尔值判定（$.loggedIn=false → 会话无效），
  // 未配置则仅按状态码（与 v1 AuthConfig 语义一致）
  if (probe.jsonPath) {
    return typeof result.value === 'boolean'
      ? (result.value ? 'authenticated' : 'unauthenticated')
      : 'unknown';
  }
  return 'authenticated';
}

/** 【C21】身份摘要：只取 identityProbe 指定的标识字段，立即摘要，不保留原值。 */
export async function readIdentityDigest(page: Page, entry: Entry): Promise<string> {
  const probe = entry.entry.identityProbe;
  const result = await requestProbe(page, {
    url: new URL(probe.url, page.url()).href,
    jsonPath: probe.jsonPath,
    authorization: await liveAuthorization(page, entry),
  });
  if (result.status < 200 || result.status >= 300 || result.value === undefined) {
    throw new Error(`identityProbe 无法取得身份标识: ${probe.url} ${probe.jsonPath}`);
  }
  return createHash('sha256').update(String(result.value)).digest('hex');
}

async function liveAuthorization(page: Page, entry: Entry): Promise<string | null> {
  if (!['bearer', 'mixed'].includes(entry.entry.sessionType)) return null;
  return entry.entry.bearerSource
    ? getLiveAuthHeader(page, entry.entry.bearerSource)
    : null;
}

function matchesLoginEvidence(text: string, markers: string[] | undefined): boolean {
  if (!markers?.length) return false;
  return markers.some((marker) => {
    if (marker === 'form') return /<form\b/i.test(text);
    if (/^input\[type=["']?password["']?\]$/i.test(marker)) {
      return /<input\b[^>]*type=["']password["']/i.test(text);
    }
    return text.includes(marker);
  });
}
