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

async function login() {
  const response = await fetch(`${baseUrl}/api/login?_nodelay=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'tester' }),
  });
  return response.headers.get('set-cookie').split(';', 1)[0];
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
