import type { ILLMProvider, ParamDefinition, Skill } from '@dsh/core';
import { z } from 'zod';

import { chatJSON } from './guard.js';

export interface RouteResult {
  skillId: string | null;
  // The skill contract permits parameter values of different primitive types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  missing: string[];
}

const RouteResponseSchema = z.object({
  skillId: z.string().nullable(),
  params: z.record(z.unknown()),
  sources: z.record(z.string()),
});

/** Select a recorded skill and extract only parameter values evidenced by the user's words. */
export async function route(
  llm: ILLMProvider,
  userInput: string,
  skills: Skill[],
): Promise<RouteResult> {
  const summaries = skills.map((skill) => ({
    id: skill.skill.id,
    name: skill.skill.name,
    description: skill.skill.description,
    params: skill.params,
  }));
  const response = await chatJSON(
    llm,
    [
      {
        role: 'system',
        content:
          '你是技能路由器。只能选择给定技能。只抽取用户明确提及的参数；每个参数必须在 sources 中给出用户原文的连续片段。enum 参数返回 label，不返回内部 value。无法匹配时 skillId 为 null。只返回 JSON。',
      },
      {
        role: 'user',
        content: JSON.stringify({ userInput, skills: summaries }),
      },
    ],
    RouteResponseSchema,
  );

  if (response.skillId === null) return { skillId: null, params: {}, missing: [] };
  const skill = skills.find((candidate) => candidate.skill.id === response.skillId);
  if (!skill) return { skillId: null, params: {}, missing: [] };

  const params: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const definition of skill.params) {
    const value = response.params[definition.name];
    const source = response.sources[definition.name];
    if (!isValidParam(value, source, userInput, definition)) {
      if (definition.required) missing.push(definition.name);
      continue;
    }
    params[definition.name] = value;
  }
  return { skillId: skill.skill.id, params, missing };
}

function isValidParam(
  value: unknown,
  source: string | undefined,
  userInput: string,
  definition: ParamDefinition,
): boolean {
  if (value === undefined || value === null || !source || !userInput.includes(source)) return false;
  if (definition.type === 'enum') {
    return typeof value === 'string' && definition.values?.some((item) => item.label === value) === true;
  }
  if (definition.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (definition.type === 'boolean') return typeof value === 'boolean';
  return typeof value === 'string' && value.length > 0;
}
