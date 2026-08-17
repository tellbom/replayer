import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { DeepSeekProvider } from './provider.js';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('DeepSeekProvider', () => {
  it('uses the OpenAI-compatible endpoint and writes a sanitized trace', async () => {
    let requestBody = '';
    let authorization = '';
    const server = createServer((request, response) => {
      authorization = String(request.headers.authorization);
      request.on('data', (chunk) => {
        requestBody += String(chunk);
      });
      request.on('end', () => {
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            choices: [{ message: { content: 'done token=response-secret' } }],
          }),
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const root = await mkdtemp(join(tmpdir(), 'dsh-llm-'));
    const tracePath = join(root, 'llm-trace.jsonl');
    const provider = new DeepSeekProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'mock-api-key',
      model: 'deepseek-chat',
      purpose: 'provider-test',
      tracePath,
    });

    const content = await provider.chat(
      [{ role: 'user', content: 'password=prompt-secret' }],
      { jsonSchema: { type: 'object' }, temperature: 0, maxTokens: 128 },
    );

    expect(content).toBe('done token=response-secret');
    expect(provider.supportsVision).toBe(false);
    expect(authorization).toBe('Bearer mock-api-key');
    expect(JSON.parse(requestBody)).toMatchObject({
      model: 'deepseek-chat',
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 128,
    });
    const trace = await readFile(tracePath, 'utf8');
    expect(trace).not.toContain('prompt-secret');
    expect(trace).not.toContain('response-secret');
    expect(JSON.parse(trace)).toMatchObject({
      purpose: 'provider-test',
      model: 'deepseek-chat',
      tokensEstimate: expect.any(Number),
      durationMs: expect.any(Number),
    });
  });

  it('retries three network errors with exponential delays', async () => {
    let calls = 0;
    const delays: number[] = [];
    const root = await mkdtemp(join(tmpdir(), 'dsh-llm-retry-'));
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls <= 3) throw new TypeError('network unavailable');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'recovered' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    const provider = new DeepSeekProvider({
      baseUrl: 'http://mock.invalid/v1',
      apiKey: 'mock-key',
      model: 'deepseek-chat',
      tracePath: join(root, 'trace.jsonl'),
      fetchImpl,
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    await expect(provider.chat([{ role: 'user', content: 'retry' }])).resolves.toBe('recovered');
    expect(calls).toBe(4);
    expect(delays).toEqual([100, 200, 400]);
  });

  it('does not retry HTTP errors', async () => {
    let calls = 0;
    const root = await mkdtemp(join(tmpdir(), 'dsh-llm-http-'));
    const provider = new DeepSeekProvider({
      baseUrl: 'http://mock.invalid/v1',
      apiKey: 'mock-key',
      model: 'deepseek-chat',
      tracePath: join(root, 'trace.jsonl'),
      fetchImpl: async () => {
        calls += 1;
        return new Response('rate limited', { status: 429 });
      },
      delay: async () => undefined,
    });

    await expect(provider.chat([{ role: 'user', content: 'hello' }])).rejects.toThrow(
      'DeepSeek HTTP 429',
    );
    expect(calls).toBe(1);
  });
});
