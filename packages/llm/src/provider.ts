import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { createSanitizer } from '@dsh/core';
import type { ILLMProvider, LLMMessage } from '@dsh/core';

export interface DeepSeekProviderOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  tracePath?: string;
  purpose?: string;
  fetchImpl?: typeof fetch;
  delay?: (milliseconds: number) => Promise<void>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

class LLMHttpError extends Error {}

export class DeepSeekProvider implements ILLMProvider {
  readonly name = 'deepseek';
  readonly supportsVision = false;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly tracePath: string;
  private readonly purpose: string;
  private readonly fetchImpl: typeof fetch;
  private readonly delay: (milliseconds: number) => Promise<void>;

  constructor(options: DeepSeekProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? requiredEnv('DSH_LLM_BASE_URL');
    this.apiKey = options.apiKey ?? requiredEnv('DSH_LLM_API_KEY');
    this.model = options.model ?? requiredEnv('DSH_LLM_MODEL');
    this.tracePath =
      options.tracePath ??
      process.env.DSH_LLM_TRACE_PATH ??
      join(process.cwd(), 'runs', 'llm-trace.jsonl');
    this.purpose = options.purpose ?? 'chat';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.delay = options.delay ?? sleep;
  }

  async chat(
    messages: LLMMessage[],
    opts?: { jsonSchema?: object; temperature?: number; maxTokens?: number },
  ): Promise<string> {
    const startedAt = Date.now();
    let responseText = '';
    try {
      for (let attempt = 0; attempt <= 3; attempt += 1) {
        try {
          const response = await this.fetchImpl(
            `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
            {
              method: 'POST',
              headers: {
                authorization: `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                model: this.model,
                messages,
                ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
                ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
                ...(opts?.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
              }),
            },
          );
          if (!response.ok) {
            throw new LLMHttpError(`DeepSeek HTTP ${response.status}: ${await response.text()}`);
          }
          const payload = (await response.json()) as ChatCompletionResponse;
          const content = payload.choices?.[0]?.message?.content;
          if (content === undefined) throw new Error('DeepSeek response has no message content');
          responseText = content;
          await this.writeTrace(messages, responseText, startedAt);
          return responseText;
        } catch (error) {
          if (error instanceof LLMHttpError || attempt === 3) throw error;
          await this.delay(100 * 2 ** attempt);
        }
      }
      throw new Error('DeepSeek retry loop ended unexpectedly');
    } catch (error) {
      responseText = `ERROR: ${String(error)}`;
      await this.writeTrace(messages, responseText, startedAt);
      throw error;
    }
  }

  private async writeTrace(
    messages: LLMMessage[],
    response: string,
    startedAt: number,
  ): Promise<void> {
    const sanitizer = createSanitizer();
    const entry = {
      ts: new Date().toISOString(),
      purpose: this.purpose,
      model: this.model,
      messages: messages.map((message) => ({
        ...message,
        content: sanitizer.sanitizeText(message.content),
      })),
      response: sanitizer.sanitizeText(response),
      tokensEstimate: estimateTokens(messages, response),
      durationMs: Date.now() - startedAt,
    };
    const serialized = JSON.stringify(entry);
    await mkdir(dirname(this.tracePath), { recursive: true });
    await appendFile(this.tracePath, `${serialized}\n`, 'utf8');
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量: ${name}`);
  return value;
}

function estimateTokens(messages: LLMMessage[], response: string): number {
  const characters = messages.reduce((total, message) => total + message.content.length, 0);
  return Math.ceil((characters + response.length) / 4);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
