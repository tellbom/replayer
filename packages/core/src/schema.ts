import { parse } from 'yaml';
import { z } from 'zod';

import type { ControlKind, LocatorStrategy } from './types.js';

export const ControlKindSchema: z.ZodType<ControlKind> = z.enum([
  'input',
  'textarea',
  'select',
  'datepicker',
  'radio',
  'checkbox',
  'button',
  'text',
]);

export const LocatorStrategySchema: z.ZodType<LocatorStrategy> = z.lazy(() =>
  z.discriminatedUnion('strategy', [
    z.object({ strategy: z.literal('el-form-item'), label: z.string(), kind: ControlKindSchema }),
    z.object({
      strategy: z.literal('el-option'),
      text: z.string(),
      ownerLabel: z.string(),
    }),
    z.object({
      strategy: z.literal('el-dialog-scoped'),
      dialogTitle: z.string(),
      inner: LocatorStrategySchema,
    }),
    z.object({
      strategy: z.literal('el-table-cell'),
      rowAnchorText: z.string(),
      buttonText: z.string(),
    }),
    z.object({
      strategy: z.literal('text'),
      text: z.string(),
      exact: z.boolean().optional(),
      nth: z.number().optional(),
    }),
    z.object({ strategy: z.literal('role'), role: z.string(), name: z.string() }),
    z.object({ strategy: z.literal('css'), selector: z.string() }),
  ]),
);

export const PostconditionSchema = z.object({
  request: z.object({
    method: z.literal('GET'),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
  match: z.object({
    jsonPath: z.string(),
    where: z.record(z.string()),
    limit: z.number().optional(),
  }),
  expectFound: z.boolean().default(true),
  timeoutMs: z.number().default(10_000),
});

export type Postcondition = z.infer<typeof PostconditionSchema>;

type UiActionName =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'selectOption'
  | 'setDateTime'
  | 'waitFor'
  | 'readValue';

export interface UiAction {
  action: UiActionName;
  url?: string | undefined;
  target?: LocatorStrategy | undefined;
  label?: string | undefined;
  kind?: ControlKind | undefined;
  value?: string | undefined;
  waitFor?:
    | { selector?: string | undefined; notEmpty?: boolean | undefined; timeoutMs?: number | undefined }
    | undefined;
  preAction?: UiAction | undefined;
  extract?: Record<string, string> | undefined;
}

export const UiActionSchema: z.ZodType<UiAction> = z.lazy(() =>
  z.object({
    action: z.enum([
      'navigate',
      'click',
      'fill',
      'selectOption',
      'setDateTime',
      'waitFor',
      'readValue',
    ]),
    url: z.string().optional(),
    target: LocatorStrategySchema.optional(),
    label: z.string().optional(),
    kind: ControlKindSchema.optional(),
    value: z.string().optional(),
    waitFor: z
      .object({
        selector: z.string().optional(),
        notEmpty: z.boolean().optional(),
        timeoutMs: z.number().optional(),
      })
      .optional(),
    preAction: UiActionSchema.optional(),
    extract: z.record(z.string()).optional(),
  }),
);

export const StepSchema = z.object({
  id: z.string(),
  desc: z.string(),
  channel: z.enum(['network', 'ui', 'merged', 'auto']),
  riskLevel: z.enum(['read', 'write', 'critical']).default('read'),
  hasSideEffect: z.boolean().default(false),
  network: z
    .object({
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
      url: z.string(),
      headers: z.record(z.string()).optional(),
      contentType: z.enum(['json', 'form']).default('json'),
      // 冻结契约允许请求体字段保存任意 JSON 值。
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body: z.record(z.any()).optional(),
      extract: z.record(z.string()).optional(),
    })
    .optional(),
  ui: UiActionSchema.optional(),
  postcondition: PostconditionSchema.optional(),
});

export const PreflightSchema = z.object({
  name: z.string(),
  request: z
    .object({
      method: z.enum(['GET', 'POST']).default('GET'),
      url: z.string(),
      headers: z.record(z.string()).optional(),
    })
    .optional(),
  extract: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('dom'),
      selector: z.string(),
      attribute: z.string().default('value'),
    }),
    z.object({ type: z.literal('jsonPath'), path: z.string() }),
    z.object({
      type: z.literal('regex'),
      pattern: z.string(),
      group: z.number().default(1),
    }),
  ]),
});

export const EnumValueSchema = z.object({
  label: z.string(),
  value: z.string(),
});

export const ParamSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'date', 'datetime', 'enum', 'boolean']),
  values: z.array(EnumValueSchema).optional(),
  required: z.boolean().default(true),
  format: z.string().optional(),
  prompt: z.string().optional(),
});

export type ParamDefinition = z.infer<typeof ParamSchema>;

export const AssertionSchema = z.object({
  type: z.enum(['httpStatus', 'jsonPath', 'textPresent', 'regexExtract']),
  // 冻结契约允许断言期望值为任意类型。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  expect: z.any().optional(),
  path: z.string().optional(),
  pattern: z.string().optional(),
  name: z.string().optional(),
});

export const SkillSchema = z.object({
  skill: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    system: z.string(),
    baseUrl: z.string(),
    version: z.number().default(1),
    recordedAt: z.string().optional(),
  }),
  auth: z
    .object({
      probeUrl: z.string(),
      sessionApi: z.string().optional(),
      loggedInJsonPath: z.string().optional(),
      loginUrlPatterns: z.array(z.string()).default([]),
      loginDomMarkers: z.array(z.string()).optional(),
      loginTimeoutMs: z.number().default(300_000),
    })
    .optional(),
  params: z.array(ParamSchema),
  preflight: z.array(PreflightSchema).default([]),
  steps: z.array(StepSchema),
  assertions: z.array(AssertionSchema).default([]),
  postcondition: PostconditionSchema.optional(),
  _healHistory: z
    .array(
      z.object({
        at: z.string(),
        step: z.string(),
        reason: z.string(),
        // 冻结契约保留修复前后的原始结构。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        old: z.any(),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new: z.any(),
        verified: z.boolean(),
        model: z.string(),
      }),
    )
    .optional(),
  _notes: z.array(z.string()).optional(),
});

export type Step = z.infer<typeof StepSchema>;
export type Skill = z.infer<typeof SkillSchema>;

export function parseSkill(yamlText: string): Skill {
  return SkillSchema.parse(parse(yamlText));
}
