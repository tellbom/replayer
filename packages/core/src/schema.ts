import { parse } from 'yaml';
import { z } from 'zod';

import { assertNoPlainCredentials } from './sanitize.js';
import { SchemaViolationError } from './errors.js';
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
    z.object({
      strategy: z.literal('playwright'),
      selector: z.string(),
      confidence: z.enum(['HIGH', 'LOW']).optional(),
    }),
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

/** 【v2.0 C18】bearer 内存态系统的 token 就地取用来源 */
export const BearerSourceSchema = z.object({
  strategy: z.enum(['storage', 'global', 'cdp-inherit', 'ui-only']),
  key: z.string().optional(),
  globalPath: z.string().optional(),
  triggerUrl: z.string().optional(),
});

export type BearerSource = z.infer<typeof BearerSourceSchema>;

/**
 * 【v2.0】Entry：认证载体配置。技能通过 skill.entry 引用，自身不含登录环节（C16）。
 */
export const EntrySchema = z.object({
  entry: z.object({
    id: z.string(),
    name: z.string(),

    via: z.enum(['portal', 'direct']),
    portalUrl: z.string().optional(),
    linkText: z.string().optional(),
    directUrl: z.string().optional(),

    landingUrlPattern: z.string(),

    /** 【C19】必须排除的一次性认证跳转 */
    excludeUrlPatterns: z
      .array(z.string())
      .default(['\\?token=', '\\?ticket=', '/sso/callback', '/sso/redirect']),

    /** 【C18】由 dsh doctor --probe-entry 探测得出 */
    sessionType: z.enum(['cookie', 'bearer', 'mixed', 'unknown']).default('unknown'),
    bearerSource: BearerSourceSchema.optional(),
    channelCapability: z
      .object({
        network: z.boolean(),
        ui: z.boolean().default(true),
      })
      .optional(),

    /** 会话存活探测 */
    sessionProbe: z.object({
      url: z.string(),
      jsonPath: z.string().optional(),
      okStatus: z.array(z.number()).default([200]),
    }),

    /** 【C21】身份一致性探测 */
    identityProbe: z.object({
      url: z.string(),
      jsonPath: z.string(),
    }),

    loginUrlPatterns: z.array(z.string()).default([]),
    loginDomMarkers: z.array(z.string()).optional(),
    loginTimeoutMs: z.number().default(300_000),

    /** 【二期预留，一期恒 none】 */
    credentialProvider: z
      .object({
        type: z.enum(['none', 'vault', 'os-keychain', 'enterprise-sso-agent']).default('none'),
        ref: z.string().default(''),
        ttlMs: z.number().default(30_000),
      })
      .default({ type: 'none', ref: '', ttlMs: 30_000 }),
  }),
});

export type Entry = z.infer<typeof EntrySchema>;

/** 【v2.0 C22】重入策略：从锚点重跑幂等前缀，不是从断点继续 */
export const ReentrySchema = z.object({
  strategy: z.enum(['restart-from-anchor', 'abort']).default('restart-from-anchor'),
  identityLock: z.boolean().default(true),
  anchor: z.string(),
  maxReentries: z.number().default(2),
});

export type Reentry = z.infer<typeof ReentrySchema>;

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
  scope?: string | undefined;
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
    scope: z.string().optional(),
  }),
);

export const ProducesSchema = z.object({
  scopeId: z.string(),
  root: LocatorStrategySchema,
  kind: z.enum(['dialog', 'drawer', 'listbox', 'menu', 'datepicker', 'table-row', 'panel', 'unknown']),
  portaled: z.boolean().default(false),
  appearedAfterMs: z.number().optional(),
});

export const WaitAfterSchema = z.object({
  scopeReady: z.string().optional(),
  urlPattern: z.string().optional(),
  networkIdle: z.boolean().optional(),
  requestUrlPattern: z.string().optional(),
  notEmpty: LocatorStrategySchema.optional(),
  settleMs: z.number().optional(),
  timeoutMs: z.number().default(8_000),
});

export const StepSchema = z.object({
  id: z.string(),
  desc: z.string(),
  channel: z.enum(['network', 'ui', 'merged', 'auto']),
  riskLevel: z.enum(['read', 'write', 'critical']).default('read'),
  hasSideEffect: z.boolean().default(false),
  /**
   * 【C22】重跑是否无副作用。未显式声明时按 riskLevel 推导：read → true，write/critical → false
   */
  idempotent: z.boolean().optional(),
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
  requires: z.array(z.string()).default([]),
  produces: ProducesSchema.optional(),
  waitAfter: WaitAfterSchema.optional(),
  pageState: z.string().optional(),
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
    /** 【C16】引用 entries/<id>.yaml，技能内不再有 auth 段 */
    entry: z.string(),
    version: z.number().default(1),
    recordedAt: z.string().optional(),
  }),
  params: z.array(ParamSchema),
  preflight: z.array(PreflightSchema).default([]),
  steps: z.array(StepSchema),
  assertions: z.array(AssertionSchema).default([]),
  postcondition: PostconditionSchema.optional(),
  reentry: ReentrySchema.optional(),
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

/** 【v2.0】未显式声明 idempotent 时按 riskLevel 推导（C22 校验用同一规则）。 */
export function stepIsIdempotent(step: Step): boolean {
  return step.idempotent ?? step.riskLevel === 'read';
}

export function parseSkill(yamlText: string, entryResolver: (id: string) => Entry): Skill {
  const skill = SkillSchema.parse(parse(yamlText));
  const entry = entryResolver(skill.skill.entry);

  // 【C17】明文凭证拒绝
  assertNoPlainCredentials(skill.steps, 'steps');
  assertNoPlainCredentials(skill.preflight, 'preflight');

  // 【C18】bearer 内存态系统禁止 network 通道
  const netUnavailable =
    entry.entry.sessionType === 'bearer' && entry.entry.bearerSource?.strategy === 'ui-only';
  if (netUnavailable) {
    const bad = skill.steps.filter((s) => s.channel === 'network' || s.channel === 'auto');
    if (bad.length) {
      throw new SchemaViolationError(
        `[C18] entry "${entry.entry.id}" 的 sessionType=bearer/ui-only，network 通道不可用。` +
          `以下步骤必须改为 channel: ui —— ${bad.map((s) => s.id).join(', ')}`,
      );
    }
  }

  // 【C22】anchor 之前的步骤必须幂等
  if (skill.reentry) {
    const idx = skill.steps.findIndex((s) => s.id === skill.reentry!.anchor);
    if (idx < 0) {
      throw new SchemaViolationError(`reentry.anchor "${skill.reentry.anchor}" 不存在`);
    }
    const bad = skill.steps.slice(0, idx + 1).filter((s) => !stepIsIdempotent(s));
    if (bad.length) {
      throw new SchemaViolationError(
        `[C22] anchor 之前存在非幂等步骤：${bad.map((s) => s.id).join(', ')}。` +
          `重入会重跑这些步骤并产生重复副作用。请把 anchor 前移，或标记这些步骤为幂等。`,
      );
    }
  }
  return skill;
}

export function parseEntry(yamlText: string): Entry {
  const entry = EntrySchema.parse(parse(yamlText));
  if (entry.entry.credentialProvider.type !== 'none') {
    throw new SchemaViolationError(
      `entry "${entry.entry.id}" 的 credentialProvider.type=${entry.entry.credentialProvider.type} 属于二期能力，一期恒为 none。`,
    );
  }
  return entry;
}
