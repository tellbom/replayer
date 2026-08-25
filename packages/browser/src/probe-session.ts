import type { BearerSource, Entry } from '@dsh/core';
import type { Page } from 'playwright';

import { attachCDP } from './cdp.js';

export interface SessionTypeProbeResult {
  sessionType: 'cookie' | 'bearer' | 'mixed' | 'unknown';
  bearerSource?: BearerSource;
  channelCapability: { network: boolean; ui: boolean };
  /** 探测证据，供 doctor 输出 */
  evidence: string[];
}

export type CookieKind = 'persistent' | 'session' | 'mixed' | 'unknown';

export function classifyCookieKind(cookies: Array<{ expires: number }>): CookieKind {
  if (cookies.length === 0) return 'unknown';
  const hasPersistent = cookies.some((cookie) => cookie.expires > 0);
  const hasSession = cookies.some((cookie) => cookie.expires <= 0);
  if (hasPersistent && hasSession) return 'mixed';
  return hasPersistent ? 'persistent' : 'session';
}

/**
 * 【T-57】探测子系统的会话类型。触发一次页面自身的无害请求，
 * 用 CDP 观察该请求的认证头，据此判定 cookie / bearer / mixed。
 */
export async function probeSessionType(
  page: Page,
  triggerUrl?: string,
): Promise<SessionTypeProbeResult> {
  const cdp = await attachCDP(page);
  await cdp.enableNetwork();
  const observed = new Promise<{ authorization: boolean; cookie: boolean }>((resolve) => {
    const timer = setTimeout(() => resolve({ authorization: false, cookie: false }), 10_000);
    cdp.session.on('Network.requestWillBeSent', (event: unknown) => {
      const request = (event as { request: { headers: Record<string, string>; url: string } }).request;
      const authorization = Boolean(request.headers['Authorization'] ?? request.headers['authorization']);
      const cookie = Boolean(request.headers['Cookie'] ?? request.headers['cookie']);
      if (authorization || cookie) {
        clearTimeout(timer);
        resolve({ authorization, cookie });
      }
    });
  });
  const target = triggerUrl ? new URL(triggerUrl, page.url()).href : page.url();
  await page.evaluate(async (url) => {
    void fetch(url, { credentials: 'include' }).catch(() => undefined);
  }, target);
  const result = await observed;
  await cdp.session.detach();

  const evidence = [`Authorization=${result.authorization}`, `Cookie=${result.cookie}`];
  if (!result.authorization && !result.cookie) {
    return { sessionType: 'unknown', channelCapability: { network: false, ui: true }, evidence };
  }
  if (result.cookie && !result.authorization) {
    return { sessionType: 'cookie', channelCapability: { network: true, ui: true }, evidence };
  }

  const sessionType = result.authorization && result.cookie ? 'mixed' : 'bearer';
  const bearerSource = await locateBearerSource(page, triggerUrl);
  evidence.push(`bearerSource=${bearerSource.strategy}`);
  return {
    sessionType,
    bearerSource,
    channelCapability: { network: bearerSource.strategy !== 'ui-only', ui: true },
    evidence,
  };
}

/** bearer 来源定位：按序尝试 storage → global → cdp-inherit → ui-only。 */
export async function locateBearerSource(
  page: Page,
  triggerUrl?: string,
): Promise<BearerSource> {
  const fromStorage = await page.evaluate(() => {
    const re = /token|auth|kc-/i;
    for (const store of [sessionStorage, localStorage]) {
      for (const k of Object.keys(store)) {
        if (!re.test(k)) continue;
        const raw = store.getItem(k);
        if (!raw) continue;
        try {
          const v = JSON.parse(raw) as { access_token?: string; token?: string; accessToken?: string };
          if (v?.access_token ?? v?.token ?? v?.accessToken) return k;
        } catch {
          if (/^ey[A-Za-z0-9_-]+\./.test(raw)) return k;
        }
      }
    }
    return null;
  });
  if (fromStorage) return { strategy: 'storage', key: 'token|auth|kc-' };

  const fromGlobal = await page.evaluate(() => {
    // 常见全局挂载点：keycloak.token
    const kc = (window as unknown as Record<string, unknown>).keycloak as
      | { token?: string }
      | undefined;
    return kc?.token ? 'keycloak.token' : null;
  });
  if (fromGlobal) return { strategy: 'global', globalPath: fromGlobal };

  if (triggerUrl) return { strategy: 'cdp-inherit', triggerUrl };
  return { strategy: 'ui-only' };
}

/** entry YAML 的默认骨架，供 doctor --probe-entry 生成后人工复核。 */
export function draftEntryYaml(
  partial: Pick<Entry['entry'], 'id' | 'name' | 'via'> &
    Partial<Pick<Entry['entry'], 'portalUrl' | 'linkText' | 'directUrl' | 'landingUrlPattern'>> &
    Pick<SessionTypeProbeResult, 'sessionType' | 'bearerSource' | 'channelCapability'> & {
      cookieKind?: CookieKind;
      sessionStrategy?: Entry['entry']['sessionHolding']['strategy'];
    },
): string {
  const lines = [
    `entry:`,
    `  id: ${partial.id}`,
    `  name: ${partial.name}`,
    `  via: ${partial.via}`,
  ];
  if (partial.via === 'portal' && partial.portalUrl) lines.push(`  portalUrl: ${partial.portalUrl}`);
  if (partial.via === 'portal' && partial.linkText) lines.push(`  linkText: ${partial.linkText}`);
  if (partial.via === 'direct' && partial.directUrl) lines.push(`  directUrl: ${partial.directUrl}`);
  lines.push(
    `  landingUrlPattern: ${partial.landingUrlPattern ?? '/home'}`,
    `  sessionType: ${partial.sessionType}`,
  );
  if (partial.bearerSource) {
    lines.push(
      `  bearerSource:`,
      `    strategy: ${partial.bearerSource.strategy}`,
      ...(partial.bearerSource.key ? [`    key: ${partial.bearerSource.key}`] : []),
      ...(partial.bearerSource.globalPath
        ? [`    globalPath: ${partial.bearerSource.globalPath}`]
        : []),
      ...(partial.bearerSource.triggerUrl
        ? [`    triggerUrl: ${partial.bearerSource.triggerUrl}`]
        : []),
    );
  }
  lines.push(
    `  channelCapability:`,
    `    network: ${partial.channelCapability.network}`,
    `    ui: ${partial.channelCapability.ui}`,
    `  sessionHolding:`,
    `    strategy: ${partial.sessionStrategy ?? 'daemon'}`,
    `    probeIntervalMs: 30000`,
    `    stateTtlMs: 1800000`,
    `    cookieKind: ${partial.cookieKind ?? 'unknown'}`,
    `  # TODO: 请人工复核 sessionProbe / identityProbe / loginUrlPatterns`,
    `  sessionProbe: { url: '', okStatus: [200] }`,
    `  identityProbe: { url: '', jsonPath: '', requiresAuth: false }`,
  );
  return `${lines.join('\n')}\n`;
}
