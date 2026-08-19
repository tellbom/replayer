import { ForbiddenError, LoginTimeoutError, TIMEOUTS, type AuthState, type Entry } from '@dsh/core';
import type { Page } from 'playwright';

export interface AuthConfig {
  probeUrl: string;
  sessionApi?: string;
  loggedInJsonPath?: string;
  loginUrlPatterns: string[];
  loginDomMarkers?: string[];
  loginTimeoutMs: number;
}

export async function getAuthState(page: Page, auth: AuthConfig): Promise<AuthState> {
  if (auth.sessionApi) {
    const result = await page.evaluate(async (sessionApi) => {
      try {
        const response = await fetch(sessionApi, { credentials: 'include' });
        return { status: response.status, text: await response.text() };
      } catch {
        return null;
      }
    }, auth.sessionApi);
    if (!result) return 'unknown';
    if (result.status === 401) return 'unauthenticated';
    if (result.status === 403) return 'forbidden';
    if (result.status < 200 || result.status >= 300) return 'unknown';

    if (auth.loggedInJsonPath) {
      try {
        const value = readJsonPath(JSON.parse(result.text), auth.loggedInJsonPath);
        if (typeof value === 'boolean') return value ? 'authenticated' : 'unauthenticated';
      } catch {
        return matchesLoginHtml(result.text, auth.loginDomMarkers)
          ? 'unauthenticated'
          : 'unknown';
      }
    }
    if (matchesLoginHtml(result.text, auth.loginDomMarkers)) return 'unauthenticated';
    return 'unknown';
  }

  if (auth.loginUrlPatterns.some((pattern) => page.url().includes(pattern))) {
    return 'unauthenticated';
  }
  if (await pageMatchesLoginMarker(page, auth.loginDomMarkers)) return 'unauthenticated';
  return 'unknown';
}

export async function ensureLoggedIn(page: Page, auth: AuthConfig): Promise<void> {
  let state = await getAuthState(page, auth);
  if (state === 'authenticated') return;
  if (state === 'forbidden') throw new ForbiddenError('当前用户无权访问目标系统');
  if (state === 'unknown') {
    await page.goto(new URL(auth.probeUrl, page.url()).href);
    state = await getAuthState(page, auth);
    if (state === 'authenticated') return;
    if (state === 'forbidden') throw new ForbiddenError('当前用户无权访问目标系统');
    if (state === 'unknown') throw new Error('认证状态未知，probe 后仍无法判断');
  }

  await page.bringToFront();
  await showLoginHint(page);
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
  await ensureLoggedIn(page, entryToAuthConfig(entry));
}

export function entryToAuthConfig(entry: Entry): AuthConfig {
  return {
    probeUrl: entry.entry.directUrl ?? entry.entry.portalUrl ?? entry.entry.landingUrlPattern,
    sessionApi: entry.entry.sessionProbe.url,
    loggedInJsonPath: entry.entry.sessionProbe.jsonPath,
    loginUrlPatterns: entry.entry.loginUrlPatterns,
    loginDomMarkers: entry.entry.loginDomMarkers,
    loginTimeoutMs: entry.entry.loginTimeoutMs,
  };
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

async function showLoginHint(page: Page): Promise<void> {
  await page.evaluate(() => {
    const hint = document.createElement('div');
    hint.id = '__dsh_login_hint__';
    hint.textContent = 'DSH：请在当前窗口完成登录';
    Object.assign(hint.style, {
      position: 'fixed',
      inset: '0 0 auto 0',
      zIndex: '2147483647',
      padding: '12px',
      color: 'white',
      background: '#1677ff',
      textAlign: 'center',
    });
    document.body.append(hint);
  });
}

async function removeLoginHint(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelector('#__dsh_login_hint__')?.remove());
}

function readJsonPath(value: unknown, path: string): unknown {
  const segments = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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
