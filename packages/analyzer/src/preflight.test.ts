import type { RecordedRequest } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { detectAuth, detectPreflight } from './preflight.js';
import { testSession, type MutableTestSession } from './test-session-fixture.js';

describe('detectPreflight', () => {
  it('does not invent a global request or DOM read from header names', () => {
    const session = baseSession();
    session.network = [request({ headers: { 'x-csrf-token': 'fingerprint' } })];
    expect(detectPreflight(session)).toEqual([]);
  });

  it('does not invent a GET for an unexplained form literal', () => {
    const session = baseSession();
    session.pages = [{ ts: 1, url: 'http://oa/legacy/overtime', title: 'Legacy' }];
    session.network = [
      request({
        url: 'http://oa/legacy/overtime/submit',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: 'runtimeNonce=fingerprint&userChoice=selected',
      }),
    ];
    session.events = [{ ts: 0, type: 'fill', name: 'userChoice', value: 'selected' }];
    expect(detectPreflight(session)).toEqual([]);
  });

  it('does not move a recorded response request into global preflight', () => {
    const session = baseSession();
    session.network = [
      request({
        method: 'GET',
        url: 'http://oa/api/csrf',
        postData: null,
        responseBody: JSON.stringify({ token: 'fingerprint' }),
      }),
    ];
    expect(detectPreflight(session)).toEqual([]);
  });
});

describe('detectAuth', () => {
  it('does not guess authentication contracts from familiar endpoint or field names', () => {
    const session = baseSession();
    session.pages = [{ ts: 1, url: 'http://oa/login', title: '登录' }];
    session.network = [
      request({ url: 'http://oa/api/private', status: 401 }),
      request({
        method: 'GET',
        url: 'http://oa/api/session',
        status: 200,
        postData: null,
        responseBody: JSON.stringify({ loggedIn: false }),
      }),
    ];
    expect(detectAuth(session).auth).toBeUndefined();
  });

  it('records forbidden evidence without treating 403 as login expiry', () => {
    const session = baseSession();
    session.network = [request({ url: 'http://oa/api/admin', status: 403 })];
    const result = detectAuth(session);
    expect(result.auth).toBeUndefined();
    expect(result.forbiddenUrls).toEqual(['http://oa/api/admin']);
  });
});

function baseSession(): MutableTestSession {
  return testSession({
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome', entryId: 'oa' },
    events: [],
    network: [],
    pages: [],
  });
}

function request(overrides: Partial<RecordedRequest>): RecordedRequest {
  return {
    requestId: 'request-1',
    requestTs: 1,
    responseTs: 2,
    method: 'POST',
    url: 'http://oa/api/submit',
    resourceType: 'fetch',
    headers: { 'content-type': 'application/json' },
    postData: '{}',
    status: 200,
    responseBody: '{}',
    mutating: true,
    sanitizeMode: 'structured',
    actionIdx: null,
    causality: 'none',
    causalityDebug: null,
    ...overrides,
  };
}
