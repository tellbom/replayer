import { describe, expect, it } from 'vitest';

import { parseSkill, SkillSchema, type ParamDefinition } from './schema.js';
import { resolveTemplate } from './template.js';
import type { ExecContext } from './types.js';

const context: ExecContext = {
  params: {
    type: '工作日加班',
    startTime: '2026-08-18 18:00:00',
    reason: '版本上线',
  },
  vars: { csrf: 'runtime-csrf' },
  stepResults: { s2: { approverId: 1023 } },
  baseUrl: 'http://localhost:5173',
};

const paramDefinitions: ParamDefinition[] = [
  {
    name: 'type',
    type: 'enum',
    required: true,
    values: [
      { label: '工作日加班', value: 'workday' },
      { label: '周末加班', value: 'weekend' },
    ],
  },
];

describe('模板引擎', () => {
  it('解析普通参数', () => {
    expect(resolveTemplate('{{reason}}', context)).toBe('版本上线');
  });

  it('解析跨步引用并保留原始值类型', () => {
    expect(resolveTemplate('{{s2.approverId}}', context)).toBe(1023);
  });

  it('解析 preflight 变量', () => {
    expect(resolveTemplate('Bearer {{csrf}}', context)).toBe('Bearer runtime-csrf');
  });

  it('用已批准的 label/value 契约解析 enumValue', () => {
    expect(resolveTemplate('{{type|enumValue}}', context, paramDefinitions)).toBe('workday');
  });

  it('格式化日期', () => {
    expect(resolveTemplate('{{startTime|date:YYYY-MM-DD}}', context)).toBe('2026-08-18');
  });

  it('变量缺失时抛错', () => {
    expect(() => resolveTemplate('{{missing}}', context)).toThrow('模板变量不存在: missing');
  });

  it('枚举 label 缺失时抛错', () => {
    const invalidContext = { ...context, params: { ...context.params, type: '不存在' } };
    expect(() => resolveTemplate('{{type|enumValue}}', invalidContext, paramDefinitions)).toThrow(
      '枚举参数不存在 label: 不存在',
    );
  });

  it('递归替换嵌套对象与数组并返回深拷贝', () => {
    const source = {
      body: { reason: '{{reason}}', approverId: '{{s2.approverId}}' },
      headers: ['{{csrf}}'],
    };
    const result = resolveTemplate(source, context);

    expect(result).toEqual({
      body: { reason: '版本上线', approverId: 1023 },
      headers: ['runtime-csrf'],
    });
    expect(result).not.toBe(source);
    expect(result.body).not.toBe(source.body);
    expect(source.body.reason).toBe('{{reason}}');
  });
});

describe('Skill Schema', () => {
  it('解析包含 step/skill postcondition 的 YAML 并应用默认值', () => {
    const skill = parseSkill(`
skill:
  id: oa_overtime_submit
  name: 提交加班
  system: mock-oa
  baseUrl: http://localhost:5173
params:
  - name: type
    type: enum
    values:
      - { label: 工作日加班, value: workday }
steps:
  - id: s1
    desc: 选择加班类型
    channel: network
    network:
      method: POST
      url: /api/overtime/approver
      body: { type: "{{type|enumValue}}" }
    postcondition:
      request: { method: GET, url: /api/overtime/history?limit=5 }
      match:
        jsonPath: $.list[*]
        where: { type: "{{type|enumValue}}" }
postcondition:
  request: { method: GET, url: /api/overtime/history?limit=5 }
  match:
    jsonPath: $.list[*]
    where: { type: "{{type|enumValue}}" }
`);

    expect(skill.skill.version).toBe(1);
    expect(skill.params[0]?.required).toBe(true);
    expect(skill.steps[0]?.riskLevel).toBe('read');
    expect(skill.steps[0]?.hasSideEffect).toBe(false);
    expect(skill.steps[0]?.postcondition?.expectFound).toBe(true);
    expect(skill.postcondition?.timeoutMs).toBe(10_000);
  });

  it('postcondition 只允许 GET', () => {
    const result = SkillSchema.safeParse({
      skill: { id: 'x', name: 'x', system: 'x', baseUrl: 'http://localhost' },
      params: [],
      steps: [],
      postcondition: {
        request: { method: 'POST', url: '/api/history' },
        match: { jsonPath: '$.list[*]', where: {} },
      },
    });

    expect(result.success).toBe(false);
  });

  it('拒绝旧的 enum string[] 契约', () => {
    const result = SkillSchema.safeParse({
      skill: { id: 'x', name: 'x', system: 'x', baseUrl: 'http://localhost' },
      params: [{ name: 'type', type: 'enum', values: ['工作日加班'] }],
      steps: [],
    });

    expect(result.success).toBe(false);
  });
});
