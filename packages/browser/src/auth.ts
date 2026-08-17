import type { AuthState } from '@dsh/core';
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
