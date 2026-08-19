import type { BearerSource } from '@dsh/core';
import type { Page } from 'playwright';

import { attachCDP } from './cdp.js';

/**
 * 【T-57 / C17】就地取用用户会话已产生的 Authorization 头。
 * 绝不通过登录接口换取新 token——取的是用户登录已经存在的那一个。
 * 返回值只存在于本次调用的内存中，不落盘、不进诊断包、不缓存
 * （每个 network 步骤执行前重新取一次，token 可能已刷新）。
 */
export async function getLiveAuthHeader(page: Page, source: BearerSource): Promise<string | null> {
  switch (source.strategy) {
    case 'storage':
      return page.evaluate((keyPattern) => {
        const re = new RegExp(keyPattern, 'i');
        for (const store of [sessionStorage, localStorage]) {
          for (const k of Object.keys(store)) {
            if (!re.test(k)) continue;
            const raw = store.getItem(k);
            if (!raw) continue;
            try {
              const v = JSON.parse(raw) as { access_token?: string; token?: string; accessToken?: string };
              const t = v?.access_token ?? v?.token ?? v?.accessToken;
              if (t) return `Bearer ${t}`;
            } catch {
              if (/^ey[A-Za-z0-9_-]+\./.test(raw)) return `Bearer ${raw}`;
            }
          }
        }
        return null;
      }, source.key ?? 'token|auth|kc-');

    case 'global':
      return page.evaluate((path) => {
        const t = path
          .split('.')
          .reduce<unknown>((obj, key) => (obj as Record<string, unknown> | undefined)?.[key], window);
        return typeof t === 'string' && t ? `Bearer ${t}` : null;
      }, source.globalPath ?? '');

    case 'cdp-inherit':
      return captureAuthHeaderViaCDP(page, source.triggerUrl ?? '');

    case 'ui-only':
      return null;
  }
}

/** 经 CDP 观察页面自身请求的 Authorization 头并原样借用。 */
export async function captureAuthHeaderViaCDP(
  page: Page,
  triggerUrl: string,
): Promise<string | null> {
  if (!triggerUrl) return null;
  const cdp = await attachCDP(page);
  await cdp.enableNetwork();
  const captured = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 3_000);
    cdp.session.on('Network.requestWillBeSent', (event: unknown) => {
      const request = (event as { request: { headers: Record<string, string> } }).request;
      const value = request.headers['Authorization'] ?? request.headers['authorization'];
      if (value) {
        clearTimeout(timer);
        resolve(value);
      }
    });
  });
  await page.evaluate(async (url) => {
    void fetch(url, { credentials: 'include' }).catch(() => undefined);
  }, new URL(triggerUrl, page.url()).href);
  const header = await captured;
  await cdp.session.detach();
  return header;
}
