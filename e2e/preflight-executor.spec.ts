import { expect, test } from '@playwright/test';
import type { ExecContext, Skill } from '@dsh/core';

import { executePreflights } from '../packages/replayer/src/preflight';
import { login } from './helpers';

test('preflight-executor: 提取 csrf、ViewState 与 JSON token 且诊断不泄露', async ({ page }) => {
  await login(page);
  const preflights: Skill['preflight'] = [
    {
      name: 'csrf',
      extract: { type: 'dom', selector: 'meta[name="csrf-token"]', attribute: 'content' },
    },
    {
      name: '__VIEWSTATE',
      request: { method: 'GET', url: '/legacy/overtime' },
      extract: { type: 'dom', selector: 'input[name="__VIEWSTATE"]', attribute: 'value' },
    },
    {
      name: 'jsonToken',
      request: { method: 'GET', url: '/api/csrf' },
      extract: { type: 'jsonPath', path: '$.token' },
    },
    {
      name: 'legacyToken',
      request: { method: 'GET', url: '/legacy/overtime' },
      extract: { type: 'regex', pattern: 'name="__TOKEN" value="([^"]+)"', group: 1 },
    },
  ];
  const context: ExecContext = {
    params: {},
    vars: {},
    stepResults: {},
    baseUrl: 'http://127.0.0.1:5173',
  };
  const diagnostics = await executePreflights(page, preflights, context);

  expect(String(context.vars.csrf)).not.toHaveLength(0);
  expect(String(context.vars.__VIEWSTATE)).not.toHaveLength(0);
  expect(String(context.vars.jsonToken)).not.toHaveLength(0);
  expect(String(context.vars.legacyToken)).not.toHaveLength(0);
  expect(diagnostics.map((item) => item.source)).toEqual([
    'current-dom',
    'request-dom',
    'request-json',
    'request-regex',
  ]);
  const serializedDiagnostics = JSON.stringify(diagnostics);
  expect(serializedDiagnostics).not.toContain(String(context.vars.csrf));
  expect(serializedDiagnostics).not.toContain(String(context.vars.__VIEWSTATE));
  expect(serializedDiagnostics).not.toContain(String(context.vars.jsonToken));
  expect(serializedDiagnostics).not.toContain(String(context.vars.legacyToken));
});
