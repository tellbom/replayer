import { ForbiddenError, LoginTimeoutError, TIMEOUTS, type AuthState, type Entry } from '@dsh/core';
import type { Page } from 'playwright';

import { getLiveAuthHeader } from './bearer.js';
import { requestProbe } from './probe-request.js';

export interface AuthConfig {
  probeUrl: string;
  sessionApi?: string;
  loggedInJsonPath?: string;
  loginUrlPatterns: string[];
  loginDomMarkers?: string[];
  loginTimeoutMs: number;
  okStatus?: number[];
  authorization?: string | null;
  authorizationProvider?: () => Promise<string | null>;
}

export async function getAuthState(page: Page, auth: AuthConfig): Promise<AuthState> {
  let probeText = '';
  if (auth.sessionApi) {
    let sessionUrl = auth.sessionApi;
    try {
      sessionUrl = new URL(auth.sessionApi, page.url()).href;
    } catch {
      // requestProbe 会把不可解析或不可达的请求归为 status=0，判定链继续使用页面证据。
    }
    const result = await requestProbe(page, {
      url: sessionUrl,
      jsonPath: auth.loggedInJsonPath,
      authorization: auth.authorizationProvider
        ? await auth.authorizationProvider()
        : auth.authorization,
    });
    probeText = result.text;
    if (result.status === 401) return 'unauthenticated';
    if (result.status === 403) return 'forbidden';
    const accepted = auth.okStatus
      ? auth.okStatus.includes(result.status)
      : result.status >= 200 && result.status < 300;
    if (accepted && auth.loggedInJsonPath && typeof result.value === 'boolean') {
      return result.value ? 'authenticated' : 'unauthenticated';
    }
    if (
      accepted
      && !auth.loggedInJsonPath
      && result.format === 'json'
      && !matchesLoginHtml(result.text, auth.loginDomMarkers)
    ) return 'authenticated';
  }

  if (auth.loginUrlPatterns.some((pattern) => page.url().includes(pattern))) {
    return 'unauthenticated';
  }
  if (await pageMatchesLoginMarker(page, auth.loginDomMarkers)) return 'unauthenticated';
  if (matchesLoginHtml(probeText, auth.loginDomMarkers)) return 'unauthenticated';
  return 'unknown';
}

export async function ensureLoggedIn(page: Page, auth: AuthConfig): Promise<void> {
  let state = await getAuthState(page, auth);
  if (state === 'authenticated') return;
  if (state === 'forbidden') throw new ForbiddenError('当前用户无权访问目标系统');
  if (state === 'unknown') {
    let probeUrl = auth.probeUrl;
    try {
      probeUrl = new URL(auth.probeUrl, page.url()).href;
    } catch {
      // 保留原配置交给 Playwright；导航失败会作为真实导航错误上抛。
    }
    await page.goto(probeUrl);
    state = await getAuthState(page, auth);
    if (state === 'authenticated') return;
    if (state === 'forbidden') throw new ForbiddenError('当前用户无权访问目标系统');
  }

  await page.bringToFront();
  await showLoginHint(
    page,
    state === 'unknown'
      ? 'DSH 无法确认登录状态，请在本窗口完成登录后继续'
      : 'DSH：请在当前窗口完成登录',
  );
  const startedAt = Date.now();
  while (Date.now() - startedAt < auth.loginTimeoutMs) {
    await page.waitForTimeout(TIMEOUTS.loginPoll);
    state = await getAuthState(page, auth);
    if (state === 'authenticated') {
      await removeLoginHint(page);
      return;
    }
    if (state === 'forbidden') {
      await removeLoginHint(page);
      throw new ForbiddenError('当前用户无权访问目标系统');
    }
  }
  throw new LoginTimeoutError(`等待用户登录超时: ${auth.loginTimeoutMs}ms`);
}

export async function recoverAuthentication(page: Page, auth: AuthConfig): Promise<void> {
  await ensureLoggedIn(page, auth);
}

/**
 * 【v2.0】Entry 形态的认证恢复：只重建会话，不重放业务动作（C14）。
 * 需要用户登录时只等待（横幅提示），绝不代替用户登录（C16/C17）。
 */
export async function recoverEntryAuthentication(page: Page, entry: Entry): Promise<void> {
  await ensureLoggedIn(page, entryToAuthConfig(entry, () => entryAuthorization(page, entry)));
}

export function entryToAuthConfig(
  entry: Entry,
  authorizationProvider?: () => Promise<string | null>,
): AuthConfig {
  return {
    probeUrl: entry.entry.directUrl ?? entry.entry.portalUrl ?? entry.entry.landingUrlPattern,
    sessionApi: entry.entry.sessionProbe.url,
    loggedInJsonPath: entry.entry.sessionProbe.jsonPath,
    loginUrlPatterns: entry.entry.loginUrlPatterns,
    loginDomMarkers: entry.entry.loginDomMarkers,
    loginTimeoutMs: entry.entry.loginTimeoutMs,
    okStatus: entry.entry.sessionProbe.okStatus,
    authorizationProvider,
  };
}

async function entryAuthorization(page: Page, entry: Entry): Promise<string | null> {
  if (!['bearer', 'mixed'].includes(entry.entry.sessionType) || !entry.entry.bearerSource) {
    return null;
  }
  return getLiveAuthHeader(page, entry.entry.bearerSource);
}

export function classifyAuthFromResponse(
  status: number,
  url: string,
  auth: AuthConfig,
): AuthState | null {
  if (status === 403) return 'forbidden';
  if (status === 401) return 'unauthenticated';
  if (auth.loginUrlPatterns.some((pattern) => url.includes(pattern))) return 'unauthenticated';
  return null;
}

async function showLoginHint(page: Page, message: string): Promise<void> {
  await page.evaluate((text) => {
    document.querySelector('#__dsh_login_hint__')?.remove();
    const hint = document.createElement('div');
    hint.id = '__dsh_login_hint__';
    hint.textContent = text;
    Object.assign(hint.style, {
      position: 'fixed',
      inset: '0 0 auto 0',
      zIndex: '2147483647',
      padding: '12px',
      color: 'white',
      background: '#1677ff',
      textAlign: 'center',
    });
    (document.body ?? document.documentElement).append(hint);
  }, message);
}

async function removeLoginHint(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('#__dsh_login_hint__')?.remove());
}

function matchesLoginHtml(html: string, markers: string[] | undefined): boolean {
  if (!markers?.length) return false;
  return markers.some((marker) => {
    if (marker === 'form') return /<form\b/i.test(html);
    if (marker === 'input[type="password"]' || marker === "input[type='password']") {
      return /<input\b[^>]*type=["']password["']/i.test(html);
    }
    return html.includes(marker);
  });
}

async function pageMatchesLoginMarker(page: Page, markers: string[] | undefined): Promise<boolean> {
  if (!markers?.length) return false;
  for (const marker of markers) {
    if ((await page.locator(marker).count()) > 0) return true;
  }
  return false;
}
