import { describe, expect, it } from 'vitest';

import { InvalidParameterTypeError } from './errors.js';
import { parseSkill } from './schema.js';
import { assertNoUnresolvedExecutableValues, validateExecutionParams } from './safety.js';

const entryResolver = () => ({
  entry: {
    id: 'fixture', name: 'fixture', via: 'direct' as const,
    directUrl: 'http://fixture/', landingUrlPattern: '/', excludeUrlPatterns: [],
    sessionType: 'cookie' as const,
    sessionProbe: { url: '/session', okStatus: [200] },
    identityProbe: { url: '/identity', jsonPath: '$.id', requiresAuth: true as const },
    loginUrlPatterns: [], loginTimeoutMs: 1_000,
    sessionHolding: {
      strategy: 'daemon' as const, probeIntervalMs: 30_000, stateTtlMs: 1_800_000,
      cookieKind: 'session' as const,
    },
    credentialProvider: { type: 'none' as const, ref: '', ttlMs: 30_000 },
  },
});

describe('Phase 0 execution parameter gate', () => {
  it('rejects a non-boolean value for a boolean parameter before channel fallback', () => {
    expect(() => validateExecutionParams(
      [{ name: 'enabled', type: 'boolean', required: true }],
      { enabled: ['unexpected'] },
    )).toThrow(InvalidParameterTypeError);
  });
});

function skill(extra: string, params = '[]'): string {
  return `
skill: { id: safety, name: safety, system: fixture, baseUrl: http://fixture, entry: fixture }
params: ${params}
steps: [{ id: read, desc: read, channel: ui, ui: { action: navigate, url: / } }]
${extra}
`;
}

describe('Phase 0 static unresolved-value gate', () => {
  it.each([
    ['body leaf', { steps: [{ network: { body: { nested: ['TODO_UNRESOLVED'] } } }] }],
    ['header', { steps: [{ network: { headers: { 'x-value': 'TODO_UNRESOLVED' } } }] }],
    ['URL/query', { steps: [{ network: { url: '/submit?q=TODO_UNRESOLVED' } }] }],
    ['UI value', { steps: [{ ui: { value: 'TODO_UNRESOLVED' } }] }],
    ['merged value', { steps: [{ channel: 'merged', ui: { value: 'TODO_UNRESOLVED' } }] }],
    ['multipart field/file reference', { steps: [{ network: { body: { fields: { a: 'TODO_UNRESOLVED' }, files: ['TODO_UNRESOLVED'] } } }] }],
    ['extract', { steps: [{ network: { extract: { id: 'TODO_UNRESOLVED' } } }] }],
    ['postcondition', { postcondition: { match: { where: { id: 'TODO_UNRESOLVED' } } } }],
  ])('rejects TODO_UNRESOLVED in executable %s', (_name, value) => {
    expect(() => assertNoUnresolvedExecutableValues(value)).toThrow(/TODO_UNRESOLVED/);
  });

  it('rejects a TODO_UNRESOLVED parameter default before schema stripping', () => {
    expect(() => parseSkill(skill('', `
  - { name: value, type: string, required: false, default: TODO_UNRESOLVED }
`), entryResolver)).toThrow(/TODO_UNRESOLVED/);
  });

  it('allows TODO_UNRESOLVED in diagnostic-only fields', () => {
    expect(() => parseSkill(skill(`
_notes: ["TODO_UNRESOLVED: diagnostic only"]
_healHistory:
  - at: 2026-08-28T00:00:00.000Z
    step: read
    reason: diagnostic
    old: TODO_UNRESOLVED
    new: TODO_UNRESOLVED
    verified: false
    model: fixture
`), entryResolver)).not.toThrow();
  });
});
