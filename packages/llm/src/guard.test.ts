import type { ILLMProvider, LLMMessage } from '@dsh/core';
import { LLMValidationError } from '@dsh/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { chatJSON } from './guard.js';

const schema = z.object({ skillId: z.string().nullable(), confidence: z.number().min(0).max(1) });

describe('chatJSON', () => {
  it('accepts a valid fenced JSON response on the first attempt', async () => {
    const llm = mockLLM(['```json\n{"skillId":"overtime","confidence":0.9}\n```']);
    await expect(chatJSON(llm, prompt(), schema)).resolves.toEqual({
      skillId: 'overtime',
      confidence: 0.9,
    });
    expect(llm.calls).toHaveLength(1);
  });

  it('feeds the validation error back and accepts the second response', async () => {
    const llm = mockLLM([
      '{"skillId":"overtime","confidence":2}',
      '{"skillId":"overtime","confidence":0.8}',
    ]);
    await expect(chatJSON(llm, prompt(), schema)).resolves.toEqual({
      skillId: 'overtime',
      confidence: 0.8,
    });
    expect(llm.calls).toHaveLength(2);
    expect(llm.calls[1]?.at(-1)?.content).toContain('未通过 JSON Schema 校验');
    expect(llm.calls[1]?.at(-1)?.content).toContain('confidence');
  });

  it('throws after three invalid responses', async () => {
    const llm = mockLLM(['not json', '{}', '{"skillId":1,"confidence":0.5}']);
    await expect(chatJSON(llm, prompt(), schema)).rejects.toBeInstanceOf(LLMValidationError);
    expect(llm.calls).toHaveLength(3);
  });
});

function prompt(): LLMMessage[] {
  return [{ role: 'user', content: 'route this request' }];
}

function mockLLM(responses: string[]): ILLMProvider & { calls: LLMMessage[][] } {
  const calls: LLMMessage[][] = [];
  return {
    name: 'mock',
    supportsVision: false,
    calls,
    async chat(messages) {
      calls.push(messages.map((message) => ({ ...message })));
      return responses[calls.length - 1]!;
    },
  };
}
