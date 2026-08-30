import { createServer, type Server } from 'node:http';
import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { attachCDP } from './cdp.js';

let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true }));
  }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试服务器未返回 TCP 地址');
  url = `http://127.0.0.1:${address.port}/probe`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe('T-21 CDP 薄封装', () => {
  it('Network.enable 后可读取 response body', async () => {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    try {
      const page = await browser.newPage();
      const cdp = await attachCDP(page);
      await cdp.enableNetwork();
      const responseId = new Promise<string>((resolve) => {
        cdp.session.on('Network.responseReceived', (event) => {
          if (event.response.url === url) resolve(event.requestId);
        });
      });
      await page.goto(url);
      const requestId = await responseId;
      const body = await cdp.session.send('Network.getResponseBody', { requestId });
      expect(JSON.parse(body.body)).toEqual({ ok: true });
    } finally {
      await browser.close();
    }
  }, 15_000);
});
