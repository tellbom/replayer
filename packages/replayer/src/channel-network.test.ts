import type { Entry, ExecContext, ParamDefinition, Step } from '@dsh/core';
import type { Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { executeNetworkStep, readJsonPath } from './channel-network.js';

const testEntry: Entry = {
  entry: {
    id: 'oa',
    name: 'OA',
    via: 'direct',
    directUrl: 'http://oa/login',
    landingUrlPattern: '/home',
    excludeUrlPatterns: [],
    sessionType: 'cookie',
    sessionProbe: { url: '/api/session', okStatus: [200] },
    identityProbe: { url: '/api/userinfo', jsonPath: '$.sub', requiresAuth: true },
    loginUrlPatterns: [],
    loginTimeoutMs: 300_000,
    sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'unknown' },
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};

describe('executeNetworkStep', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([
    [{ known: 'ok', extra: false }, [{ name: 'known', type: 'string', required: true }], 'UnknownParameterError'],
    [{}, [{ name: 'known', type: 'string', required: true }], 'MissingParameterError'],
    [{ priority: 'normal' }, [{
      name: 'priority', type: 'enum', required: true,
      enumMap: { urgent: 'HIGH' }, values: [{ label: 'urgent', value: 'HIGH' }],
    }], 'EnumMappingError'],
  ] as const)('Phase 0 rejects invalid params before page access: %j', async (values, definitions, errorName) => {
    const step: Step = {
      id: 'write', desc: 'write', channel: 'network', riskLevel: 'write', hasSideEffect: true,
      requires: [],
      network: { method: 'POST', url: '/submit', contentType: 'json', body: { value: 'fixed' } },
    };
    const result = await executeNetworkStep({} as Page, step, {
      params: values, vars: {}, stepResults: {}, baseUrl: 'http://oa', entry: testEntry,
      identityDigest: '', scopes: {},
    }, definitions as unknown as ParamDefinition[]);

    expect(result).toMatchObject({ outcome: 'not_sent', channelUsed: 'network' });
    expect(result.error).toContain(errorName);
  });

  it('Phase 0 blocks a runtime TODO in the materialized body before page access', async () => {
    const step: Step = {
      id: 'write', desc: 'write', channel: 'network', riskLevel: 'write', hasSideEffect: true,
      requires: [],
      network: {
        method: 'POST', url: '/submit', contentType: 'json', body: { nested: ['{{value}}'] },
      },
    };
    const result = await executeNetworkStep({} as Page, step, {
      params: { value: 'TODO_UNRESOLVED' }, vars: {}, stepResults: {}, baseUrl: 'http://oa',
      entry: testEntry, identityDigest: '', scopes: {},
    }, [{ name: 'value', type: 'string', required: true }]);

    expect(result).toMatchObject({ outcome: 'not_sent', channelUsed: 'network' });
    expect(result.error).toMatch(/TODO_UNRESOLVED/);
  });

  it('Phase 0 rejects multipart requests while the runtime has no multipart carrier', async () => {
    const step: Step = {
      id: 'upload', desc: 'upload', channel: 'network', riskLevel: 'write', hasSideEffect: true,
      requires: [],
      network: {
        method: 'POST', url: '/submit', contentType: 'json',
        headers: { 'Content-Type': 'multipart/form-data; boundary=recorded-boundary' },
      },
    };

    const result = await executeNetworkStep({} as Page, step, {
      params: {}, vars: {}, stepResults: {}, baseUrl: 'http://oa', entry: testEntry,
      identityDigest: '', scopes: {},
    }, []);

    expect(result).toMatchObject({ outcome: 'not_sent', channelUsed: 'network' });
    expect(result.error).toContain('UnsupportedMultipartError');
  });

  it('sends reconstructable text-only multipart through browser FormData', async () => {
    let sentBody: BodyInit | null | undefined;
    let sentHeaders: Headers | undefined;
    vi.stubGlobal('fetch', async (_url: URL, init: RequestInit) => {
      sentBody = init.body;
      sentHeaders = init.headers as Headers;
      return new Response('{}', { status: 200 });
    });
    const page = {
      evaluate: async (fn: (arg: never) => unknown, arg: never) => fn(arg),
    } as unknown as Page;
    const step: Step = {
      id: 'text-multipart', desc: 'text multipart', channel: 'network', riskLevel: 'write', hasSideEffect: true,
      requires: [],
      network: {
        method: 'POST', url: '/submit', contentType: 'json',
        headers: { 'Content-Type': 'multipart/form-data; boundary=recorded-boundary' },
        body: { title: 'alpha', count: 2, enabled: true },
      },
    };

    const result = await executeNetworkStep(page, step, {
      params: {}, vars: {}, stepResults: {}, baseUrl: 'http://oa', entry: testEntry,
      identityDigest: '', scopes: {},
    }, []);

    expect(result.outcome).toBe('confirmed_success');
    expect(sentBody).toBeInstanceOf(FormData);
    expect(Object.fromEntries((sentBody as FormData).entries())).toEqual({
      title: 'alpha', count: '2', enabled: 'true',
    });
    expect(sentHeaders?.has('content-type')).toBe(false);
  });

  it('keeps file-like multipart carriers not_sent', async () => {
    const step: Step = {
      id: 'file-multipart', desc: 'file multipart', channel: 'network', riskLevel: 'write', hasSideEffect: true,
      requires: [],
      network: {
        method: 'POST', url: '/submit', contentType: 'json',
        headers: { 'Content-Type': 'multipart/form-data' },
        body: { file: { name: 'document.bin', size: 10, type: 'application/octet-stream' } },
      },
    };
    const result = await executeNetworkStep({} as Page, step, {
      params: {}, vars: {}, stepResults: {}, baseUrl: 'http://oa', entry: testEntry,
      identityDigest: '', scopes: {},
    }, []);
    expect(result.outcome).toBe('not_sent');
    expect(result.error).toContain('UnsupportedMultipartError');
  });

  it('requires a conditional JSONPath to identify exactly one array item', () => {
    const body = [
      { identifier: 'ACT-100', display: 'Alex' },
      { identifier: 'ACT-200', display: 'Bailey' },
    ];
    expect(readJsonPath(body, '$[?(@.display=="Alex")].identifier')).toBe('ACT-100');
    expect(() => readJsonPath(
      [...body, { identifier: 'ACT-300', display: 'Alex' }],
      '$[?(@.display=="Alex")].identifier',
    )).toThrow(/唯一命中/);
  });

  it('classifies a missing template variable as not_sent before page access', async () => {
    const step: Step = {
      id: 's1',
      desc: '缺失模板',
      channel: 'network',
      riskLevel: 'write',
      hasSideEffect: true,
      requires: [],
      network: {
        method: 'POST',
        url: '/api/submit',
        contentType: 'json',
        body: { reason: '{{missing}}' },
      },
    };
    const context: ExecContext = {
      params: {},
      vars: {},
      stepResults: {},
      baseUrl: 'http://oa',
      entry: testEntry,
      identityDigest: '',
      scopes: {},
    };
    const result = await executeNetworkStep({} as Page, step, context, []);
    expect(result.outcome).toBe('not_sent');
  });
});
