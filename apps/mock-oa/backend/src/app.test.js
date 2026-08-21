import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

let server;
let baseUrl;

beforeAll(async () => {
  server = createApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function login(cookieMode = 'session') {
  const response = await fetch(`${baseUrl}/api/login?_nodelay=1&cookieMode=${cookieMode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'tester' }),
  });
  return response.headers.get('set-cookie').split(';', 1)[0];
}

async function loginResponse(cookieMode) {
  return fetch(`${baseUrl}/api/login?_nodelay=1&cookieMode=${cookieMode}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'tester' }),
  });
}

async function authenticatedSession() {
  const cookie = await login();
  const csrfResponse = await fetch(`${baseUrl}/api/csrf?_nodelay=1`, {
    headers: { Cookie: cookie },
  });
  return { cookie, csrf: (await csrfResponse.json()).token };
}

async function postJson(path, body, session) {
  return fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}_nodelay=1`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-CSRF-TOKEN': session.csrf,
    },
    body: JSON.stringify(body),
  });
}

describe('T-04 Mock OA 后端骨架', () => {
  it('未登录 session 返回 loggedIn=false', async () => {
    const response = await fetch(`${baseUrl}/api/session?_nodelay=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ loggedIn: false });
  });

  it('未登录访问业务 API 返回 401', async () => {
    const response = await fetch(`${baseUrl}/api/overtime/types?_nodelay=1`);
    expect(response.status).toBe(401);
  });

  it('任意非空账号密码可登录并保持 session', async () => {
    const cookie = await login();
    const response = await fetch(`${baseUrl}/api/session?_nodelay=1`, {
      headers: { Cookie: cookie },
    });
    expect(await response.json()).toEqual({ loggedIn: true, user: 'tester' });
  });

  it('默认 session cookie 不带持久属性，persistent 模式带 Max-Age', async () => {
    const sessionCookie = (await loginResponse('session')).headers.get('set-cookie');
    const defaultCookie = (await loginResponse('invalid')).headers.get('set-cookie');
    const persistentCookie = (await loginResponse('persistent')).headers.get('set-cookie');
    expect(sessionCookie).not.toMatch(/Max-Age|Expires/i);
    expect(defaultCookie).not.toMatch(/Max-Age|Expires/i);
    expect(persistentCookie).toMatch(/Expires=/i);
  });

  it('CSRF token 与 session 绑定并保持稳定', async () => {
    const first = await fetch(`${baseUrl}/api/csrf?_nodelay=1`);
    const cookie = first.headers.get('set-cookie').split(';', 1)[0];
    const firstBody = await first.json();
    const second = await fetch(`${baseUrl}/api/csrf?_nodelay=1`, {
      headers: { Cookie: cookie },
    });
    expect((await second.json()).token).toBe(firstBody.token);
  });

  it('登录后 forbidden 接口返回 403 且 session 不失效', async () => {
    const cookie = await login();
    const forbidden = await fetch(`${baseUrl}/api/_debug/forbidden?_nodelay=1`, {
      headers: { Cookie: cookie },
    });
    const session = await fetch(`${baseUrl}/api/session?_nodelay=1`, {
      headers: { Cookie: cookie },
    });
    expect(forbidden.status).toBe(403);
    expect((await session.json()).loggedIn).toBe(true);
  });

  it('expire 销毁 session', async () => {
    const cookie = await login();
    const expired = await fetch(`${baseUrl}/api/_debug/expire?_nodelay=1`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    const session = await fetch(`${baseUrl}/api/session?_nodelay=1`, {
      headers: { Cookie: cookie },
    });
    expect(expired.status).toBe(200);
    expect(await session.json()).toEqual({ loggedIn: false });
  });
});

describe('T-05 业务接口与依赖陷阱', () => {
  it('错误 approverId 必须失败', async () => {
    const session = await authenticatedSession();
    const approval = await (
      await postJson('/api/overtime/approver', { type: 'workday' }, session)
    ).json();
    const response = await postJson(
      '/api/overtime/submit',
      {
        type: 'workday',
        approverId: 9999,
        approvalToken: approval.approvalToken,
        reason: '错误审批人',
      },
      session,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: 400, msg: '审批人不匹配' });
  });

  it('跳过 approver 或缺失 approvalToken 时 submit 必须失败', async () => {
    const session = await authenticatedSession();
    const response = await postJson(
      '/api/overtime/submit',
      { type: 'workday', approverId: 1023, reason: '跳过联动' },
      session,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).msg).toContain('approvalToken');
  });

  it('切换 type 后旧 token 失效，新 approverId 与 token 可提交', async () => {
    const session = await authenticatedSession();
    const workday = await (
      await postJson('/api/overtime/approver', { type: 'workday' }, session)
    ).json();
    const weekend = await (
      await postJson('/api/overtime/approver', { type: 'weekend' }, session)
    ).json();
    const stale = await postJson(
      '/api/overtime/submit',
      {
        type: 'weekend',
        approverId: weekend.approverId,
        approvalToken: workday.approvalToken,
      },
      session,
    );
    const valid = await postJson(
      '/api/overtime/submit',
      {
        type: 'weekend',
        approverId: weekend.approverId,
        approvalToken: weekend.approvalToken,
        startTime: '2026-08-18 18:00',
        endTime: '2026-08-18 21:00',
        reason: '版本上线',
      },
      session,
    );

    expect(stale.status).toBe(400);
    expect(valid.status).toBe(200);
    expect((await valid.json()).no).toMatch(/^OT-\d{8}-\d{4}$/);
  });

  it('approvalToken 提交后消费，不能复用', async () => {
    const session = await authenticatedSession();
    const approval = await (
      await postJson('/api/overtime/approver', { type: 'workday' }, session)
    ).json();
    const body = {
      type: 'workday',
      approverId: approval.approverId,
      approvalToken: approval.approvalToken,
      reason: '单次 token',
    };
    const first = await postJson('/api/overtime/submit', body, session);
    const second = await postJson('/api/overtime/submit', body, session);

    expect(first.status).toBe(200);
    expect(second.status).toBe(400);
  });

  it('提交响应丢失时服务端只创建一条申请，history 可查到', async () => {
    const session = await authenticatedSession();
    const approval = await (
      await postJson('/api/overtime/approver', { type: 'workday' }, session)
    ).json();
    const body = {
      type: 'workday',
      approverId: approval.approverId,
      approvalToken: approval.approvalToken,
      startTime: '2026-08-19 18:00',
      endTime: '2026-08-19 21:00',
      reason: '响应丢失专项',
    };

    await expect(postJson('/api/overtime/submit?drop_response=1', body, session)).rejects.toThrow();
    const debug = await fetch(`${baseUrl}/api/_debug/submissions?_nodelay=1`, {
      headers: { Cookie: session.cookie },
    });
    const history = await fetch(`${baseUrl}/api/overtime/history?limit=5&_nodelay=1`, {
      headers: { Cookie: session.cookie },
    });

    expect((await debug.json()).count).toBe(1);
    expect((await history.json()).list[0].reason).toBe('响应丢失专项');
  });

  it('请假 balance 动态依赖可完成一次提交', async () => {
    const session = await authenticatedSession();
    const balance = await (
      await postJson('/api/leave/balance', { type: 'annual' }, session)
    ).json();
    const response = await postJson(
      '/api/leave/submit',
      {
        type: 'annual',
        balanceId: balance.balanceId,
        balanceToken: balance.balanceToken,
        reason: '家庭事务',
      },
      session,
    );

    expect(response.status).toBe(200);
    expect((await response.json()).no).toMatch(/^LV-\d{8}-\d{4}$/);
  });
});
