import type { Page } from 'playwright';

export interface ProbeRequest {
  url: string;
  jsonPath?: string;
  authorization?: string | null;
  credentials?: 'include' | 'omit';
}

export interface ProbeResponse {
  status: number;
  format: 'json' | 'text' | 'none';
  text: string;
  value?: unknown;
}

/** 通用页面内探测：只解释 HTTP/JSON 数据，不包含端点、字段或框架知识。 */
export async function requestProbe(page: Page, request: ProbeRequest): Promise<ProbeResponse> {
  return page.evaluate(async ({ url, jsonPath, authorization, credentials }) => {
    try {
      const headers: Record<string, string> = {};
      if (authorization) headers.Authorization = authorization;
      const response = await fetch(url, {
        credentials: credentials ?? 'include',
        cache: 'no-store',
        headers,
      });
      const text = await response.text();
      if (!text) return { status: response.status, format: 'none' as const, text };
      try {
        const body: unknown = JSON.parse(text);
        return {
          status: response.status,
          format: 'json' as const,
          text,
          value: jsonPath ? readPath(body, jsonPath) : body,
        };
      } catch {
        return { status: response.status, format: 'text' as const, text };
      }
    } catch {
      return { status: 0, format: 'none' as const, text: '' };
    }

    function readPath(value: unknown, path: string): unknown {
      const segments = path.replace(/^\$\.?/, '').split('.').filter(Boolean);
      let current = value;
      for (const segment of segments) {
        if (typeof current !== 'object' || current === null || !(segment in current)) return undefined;
        current = (current as Record<string, unknown>)[segment];
      }
      return current;
    }
  }, request);
}
