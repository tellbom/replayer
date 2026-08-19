import type { RecordedRequest, RecordSession } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { detectAuth, detectPreflight } from './preflight.js';

describe('detectPreflight', () => {
  it('detects Vue3 meta csrf', () => {
    const session = baseSession();
    session.network = [request({ headers: { 'x-csrf-token': 'fingerprint' } })];
    expect(detectPreflight(session)).toContainEqual({
      name: 'csrfToken',
      extract: {
        type: 'dom',
        selector: 'meta[name="csrf-token"]',
        attribute: 'content',
      },
    });
  });

  it('detects legacy ViewState form fields from the current page', () => {
    const session = baseSession();
    session.pages = [{ ts: 1, url: 'http://oa/legacy/overtime', title: 'Legacy' }];
    session.network = [
      request({
        url: 'http://oa/legacy/overtime/submit',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        postData: '__VIEWSTATE=fingerprint&__EVENTVALIDATION=fingerprint',
      }),
    ];
    expect(detectPreflight(session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: '__VIEWSTATE',
          request: { method: 'GET', url: 'http://oa/legacy/overtime' },
        }),
        expect.objectContaining({ name: '__EVENTVALIDATION' }),
      ]),
    );
  });

  it('detects a JSON token endpoint', () => {
    const session = baseSession();
    session.network = [
      request({
        method: 'GET',
        url: 'http://oa/api/csrf',
        postData: null,
        responseBody: JSON.stringify({ token: 'fingerprint' }),
      }),
    ];
    expect(detectPreflight(session)).toContainEqual({
      name: 'token',
      request: { method: 'GET', url: 'http://oa/api/csrf' },
      extract: { type: 'jsonPath', path: '$.token' },
    });
  });
});

describe('detectAuth', () => {
  it('detects login expiry and a session API', () => {
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
    expect(detectAuth(session).auth).toEqual(
      expect.objectContaining({
        sessionApi: 'http://oa/api/session',
        loggedInJsonPath: '$.loggedIn',
        loginUrlPatterns: ['/login'],
      }),
    );
  });

  it('records forbidden evidence without treating 403 as login expiry', () => {
    const session = baseSession();
    session.network = [request({ url: 'http://oa/api/admin', status: 403 })];
    const result = detectAuth(session);
    expect(result.auth).toBeUndefined();
    expect(result.forbiddenUrls).toEqual(['http://oa/api/admin']);
  });
});

function baseSession(): RecordSession {
  return {
    meta: { startedAt: '', endedAt: '', baseUrl: 'http://oa', userAgent: 'Chrome', entryId: 'oa' },
    actions: [],
    network: [],
    pages: [],
  };
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
    ...overrides,
  };
}
