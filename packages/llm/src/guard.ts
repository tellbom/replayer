import { LLMValidationError, RETRY } from '@dsh/core';
import type { ILLMProvider, LLMMessage } from '@dsh/core';
import type { z } from 'zod';

/** Request JSON from an LLM and reject every response that does not satisfy the supplied schema. */
export async function chatJSON<T>(
  llm: ILLMProvider,
  messages: LLMMessage[],
  schema: z.ZodType<T>,
  maxRetry = RETRY.llmSchemaMax,
): Promise<T> {
  const conversation = [...messages];
  let lastError: unknown;
  for (let attempt = 0; attempt < maxRetry; attempt += 1) {
    const response = await llm.chat(conversation, { jsonSchema: { type: 'object' } });
    try {
      const parsed: unknown = JSON.parse(stripJsonFence(response));
      return schema.parse(parsed);
    } catch (error) {
      lastError = error;
      conversation.push(
        { role: 'assistant', content: response },
        {
          role: 'user',
          content: `上一次输出未通过 JSON Schema 校验：${validationMessage(error)}。请只返回修正后的 JSON。`,
        },
      );
    }
  }
  throw new LLMValidationError(`LLM JSON 输出连续 ${maxRetry} 次校验失败`, {
    cause: lastError,
  });
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function validationMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
