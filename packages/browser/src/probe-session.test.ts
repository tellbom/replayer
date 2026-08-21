import { describe, expect, it } from 'vitest';

import { classifyCookieKind, draftEntryYaml } from './probe-session.js';

describe('T-76 cookieKind 探测', () => {
  it('区分 session、persistent、mixed 与 unknown', () => {
    expect(classifyCookieKind([])).toBe('unknown');
    expect(classifyCookieKind([{ expires: -1 }])).toBe('session');
    expect(classifyCookieKind([{ expires: 1_900_000_000 }])).toBe('persistent');
    expect(classifyCookieKind([{ expires: 0 }, { expires: 1_900_000_000 }])).toBe('mixed');
  });

  it('doctor 草稿写入会话持有契约', () => {
    const yaml = draftEntryYaml({
      id: 'oa',
      name: 'OA',
      via: 'direct',
      directUrl: 'https://oa.example.test',
      sessionType: 'cookie',
      channelCapability: { network: true, ui: true },
      cookieKind: 'session',
      sessionStrategy: 'storage-state',
    });
    expect(yaml).toContain('sessionHolding:\n');
    expect(yaml).toContain('strategy: storage-state');
    expect(yaml).toContain('cookieKind: session');
  });
});
