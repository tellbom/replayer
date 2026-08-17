import { SkillSchema } from '@dsh/core';
import type { ILLMProvider, Skill } from '@dsh/core';
import { Document, isNode, isSeq } from 'yaml';
import { z } from 'zod';

import { chatJSON } from './guard.js';

const AnnotationSchema = z.object({
  skill: z.object({ id: z.string(), name: z.string(), description: z.string() }),
  params: z.array(z.object({ name: z.string(), prompt: z.string() })),
  steps: z.array(z.object({ id: z.string(), desc: z.string() })),
  assertions: z.array(z.object({
    type: z.enum(['httpStatus', 'jsonPath', 'textPresent', 'regexExtract']),
    expect: z.unknown().optional(),
    path: z.string().optional(),
    pattern: z.string().optional(),
    name: z.string().optional(),
  })),
  warnings: z.array(z.string()),
});

export interface AnnotationResult {
  skill: Skill;
  yaml: string;
}

/** Add reviewable LLM suggestions to a deterministic analyzer draft. */
export async function annotate(llm: ILLMProvider, draft: Skill): Promise<AnnotationResult> {
  const annotation = await chatJSON(
    llm,
    [
      {
        role: 'system',
        content:
          '标注录制技能草稿。不得改变步骤 id、参数 name、请求、定位器、通道或副作用信息。返回更清晰的技能元数据、步骤说明、参数 prompt、断言建议和风险提示。只返回 JSON。',
      },
      { role: 'user', content: JSON.stringify(draft) },
    ],
    AnnotationSchema,
  );

  const params = draft.params.map((param) => {
    const suggestion = annotation.params.find((item) => item.name === param.name);
    return suggestion ? { ...param, prompt: suggestion.prompt } : param;
  });
  const steps = draft.steps.map((step) => {
    const suggestion = annotation.steps.find((item) => item.id === step.id);
    return suggestion ? { ...step, desc: suggestion.desc } : step;
  });
  const skill = SkillSchema.parse({
    ...draft,
    skill: { ...draft.skill, ...annotation.skill },
    params,
    steps,
    assertions: annotation.assertions,
    _notes: [...(draft._notes ?? []), ...annotation.warnings],
  });
  return { skill, yaml: renderAnnotatedYaml(skill, annotation) };
}

function renderAnnotatedYaml(skill: Skill, annotation: z.infer<typeof AnnotationSchema>): string {
  const document = new Document(skill);
  mark(document.getIn(['skill', 'id'], true));
  mark(document.getIn(['skill', 'name'], true));
  mark(document.getIn(['skill', 'description'], true));
  for (const suggestion of annotation.params) {
    const index = skill.params.findIndex((param) => param.name === suggestion.name);
    if (index >= 0) mark(document.getIn(['params', index, 'prompt'], true));
  }
  for (const suggestion of annotation.steps) {
    const index = skill.steps.findIndex((step) => step.id === suggestion.id);
    if (index >= 0) mark(document.getIn(['steps', index, 'desc'], true));
  }
  markSequence(document.get('assertions', true));
  const notes = document.get('_notes', true);
  if (isSeq(notes)) {
    for (let index = notes.items.length - annotation.warnings.length; index < notes.items.length; index += 1) {
      mark(notes.items[index]);
    }
  }
  return document.toString({ lineWidth: 0 });
}

function mark(node: unknown): void {
  if (isNode(node)) node.commentBefore = ' TODO: LLM 建议，发布前必须人工复核';
}

function markSequence(node: unknown): void {
  if (!isSeq(node)) return;
  for (const item of node.items) mark(item);
}
