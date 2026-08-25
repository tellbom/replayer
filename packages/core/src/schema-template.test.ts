import { describe, expect, it } from 'vitest';

import {
  parseEntry,
  parseSkill,
  SkillSchema,
  stepIsIdempotent,
  type Entry,
  type ParamDefinition,
} from './schema.js';
import { SchemaViolationError } from './errors.js';
import { resolveTemplate } from './template.js';
import type { ExecContext } from './types.js';

/** 测试用 entry 工厂：默认 cookie 会话（network 可用）。 */
function testEntry(overrides: Partial<Entry['entry']> = {}): Entry {
  return {
    entry: {
      id: 'oa',
      name: 'OA',
      via: 'direct',
      directUrl: 'http://localhost:5173/login',
      landingUrlPattern: '/home',
      excludeUrlPatterns: ['\\?token=', '\\?ticket=', '/sso/callback', '/sso/redirect'],
      sessionType: 'cookie',
      sessionProbe: { url: '/api/session', jsonPath: '$.loggedIn', okStatus: [200] },
      identityProbe: { url: '/api/userinfo', jsonPath: '$.sub', requiresAuth: true },
      loginUrlPatterns: ['/login'],
      loginTimeoutMs: 300_000,
      sessionHolding: { strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000, cookieKind: 'unknown' },
      credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
      ...overrides,
    },
  };
}

const entryResolver = (entry: Entry) => (id: string): Entry => {
  if (id !== entry.entry.id) throw new Error(`entry not found: ${id}`);
  return entry;
};

const context: ExecContext = {
  params: {
    type: '工作日加班',
    startTime: '2026-08-18 18:00:00',
    reason: '版本上线',
  },
  vars: { csrf: 'runtime-csrf' },
  stepResults: { s2: { approverId: 1023 } },
  baseUrl: 'http://localhost:5173',
  entry: testEntry(),
  identityDigest: 'digest-placeholder',
  scopes: {},
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

  it('优先使用 enumMap 解析 enumValue', () => {
    const definitions = [{
      name: 'type', type: 'enum' as const, required: true,
      values: [{ label: '周末加班', value: 'wrong' }],
      enumMap: { 周末加班: 'weekend' },
    }];
    const weekend = { ...context, params: { ...context.params, type: '周末加班' } };
    expect(resolveTemplate('{{type|enumValue}}', weekend, definitions)).toBe('weekend');
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
  it('拒绝加载仍含 TODO_UNRESOLVED 的草稿', () => {
    expect(() => parseSkill(`
skill: { id: unresolved, name: unresolved, system: mock, baseUrl: http://localhost, entry: oa }
params: []
steps:
  - id: s1
    desc: unresolved
    channel: network
    network: { method: POST, url: /api/submit, body: { type: TODO_UNRESOLVED } }
`, entryResolver(testEntry()))).toThrow(/TODO_UNRESOLVED/);
  });

  it('解析包含 step/skill postcondition 的 YAML 并应用默认值', () => {
    const skill = parseSkill(`
skill:
  id: oa_overtime_submit
  name: 提交加班
  system: mock-oa
  baseUrl: http://localhost:5173
  entry: oa
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
`, entryResolver(testEntry()));

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
      skill: { id: 'x', name: 'x', system: 'x', baseUrl: 'http://localhost', entry: 'oa' },
      params: [{ name: 'type', type: 'enum', values: ['工作日加班'] }],
      steps: [],
    });

    expect(result.success).toBe(false);
  });
});

describe('v2.0 Entry 契约与 parseSkill 校验', () => {
  const baseSkill = (steps: unknown, extra = ''): string => `
skill:
  id: s
  name: s
  system: mock
  baseUrl: http://localhost:5173
  entry: oa
params: []
${extra}
steps: ${JSON.stringify(steps)}
`;

  it('C17：步骤含 grant_type=password 语义被拒绝', () => {
    expect(() =>
      parseSkill(
        baseSkill([
          {
            id: 's1',
            desc: 'x',
            channel: 'network',
            network: {
              method: 'POST',
              url: '/token',
              body: { grant_type: 'password', username: 'admin', password: 'admin' },
            },
          },
        ]),
        entryResolver(testEntry()),
      ),
    ).toThrow(SchemaViolationError);
  });

  it('C17：preflight 含 password 字段被拒绝', () => {
    expect(() =>
      parseSkill(
        baseSkill(
          [],
          'preflight:\n  - name: bad\n    request: { method: POST, url: /x, headers: { password: plain-secret } }\n    extract: { type: jsonPath, path: $.token }',
        ),
        entryResolver(testEntry()),
      ),
    ).toThrow(SchemaViolationError);
  });

  it('C18：bearer/ui-only entry 下 network 通道步骤被拒绝', () => {
    const bearerOnly = testEntry({
      sessionType: 'bearer',
      bearerSource: { strategy: 'ui-only' },
    });
    expect(() =>
      parseSkill(
        baseSkill([
          { id: 's1', desc: 'x', channel: 'network', network: { method: 'GET', url: '/api/x', contentType: 'json' } },
        ]),
        entryResolver(bearerOnly),
      ),
    ).toThrow(/\[C18\]/);
    // ui 通道不受影响
    expect(() =>
      parseSkill(
        baseSkill([{ id: 's1', desc: 'x', channel: 'ui', ui: { action: 'waitFor', waitFor: { selector: '.x' } } }]),
        entryResolver(bearerOnly),
      ),
    ).not.toThrow();
  });

  it('C22：anchor 不存在 / anchor 前有非幂等步骤均被拒绝', () => {
    const writeStep = {
      id: 's1',
      desc: '写',
      channel: 'network',
      riskLevel: 'write',
      network: { method: 'POST', url: '/api/x', contentType: 'json' },
    };
    const readStep = {
      id: 's2',
      desc: '读',
      channel: 'network',
      riskLevel: 'read',
      network: { method: 'GET', url: '/api/y', contentType: 'json' },
    };
    // anchor 不存在
    expect(() =>
      parseSkill(
        baseSkill([readStep], 'reentry:\n  anchor: nope\n  maxReentries: 2'),
        entryResolver(testEntry()),
      ),
    ).toThrow(/不存在/);
    // anchor 覆盖到写步骤 → 拒绝
    expect(() =>
      parseSkill(
        baseSkill([writeStep, readStep], 'reentry:\n  anchor: s1'),
        entryResolver(testEntry()),
      ),
    ).toThrow(/\[C22\]/);
    // anchor 在读步骤（写步骤在 anchor 之后）→ 通过
    expect(() =>
      parseSkill(
        baseSkill([readStep, writeStep], 'reentry:\n  anchor: s2'),
        entryResolver(testEntry()),
      ),
    ).not.toThrow();
  });

  it('stepIsIdempotent 按 riskLevel 推导', () => {
    expect(stepIsIdempotent({ id: 'a', desc: '', channel: 'ui', riskLevel: 'read', hasSideEffect: false } as never)).toBe(true);
    expect(
      stepIsIdempotent({ id: 'a', desc: '', channel: 'ui', riskLevel: 'write', hasSideEffect: true } as never),
    ).toBe(false);
    expect(
      stepIsIdempotent({
        id: 'a',
        desc: '',
        channel: 'ui',
        riskLevel: 'write',
        hasSideEffect: true,
        idempotent: true,
      } as never),
    ).toBe(true);
  });

  it('parseEntry：credentialProvider 非 none 被拒绝（二期能力）', () => {
    const yaml = (type: string): string => `
entry:
  id: oa
  name: OA
  via: direct
  directUrl: http://localhost:5173/login
  landingUrlPattern: /home
  sessionType: cookie
  sessionProbe: { url: /api/session }
  identityProbe: { url: /api/userinfo, jsonPath: $.sub, requiresAuth: true }
  credentialProvider: { type: ${type} }
`;
    expect(() => parseEntry(yaml('none'))).not.toThrow();
    expect(() => parseEntry(yaml('vault'))).toThrow(SchemaViolationError);
  });

  it('T-92：两个逻辑探针允许复用同一 HTTP 端点', () => {
    expect(() => parseEntry(`
entry:
  id: shared-probe
  name: Shared probe
  via: direct
  directUrl: http://localhost/home
  landingUrlPattern: /home
  sessionType: bearer
  bearerSource: { strategy: storage, key: token }
  sessionProbe: { url: /account, okStatus: [200] }
  identityProbe: { url: /account, jsonPath: $.principal, requiresAuth: true }
`)).not.toThrow();
  });

  it('T-92：拒绝未经认证能力验证的身份探针与 unknown 会话类型', () => {
    const yaml = (sessionType: string, requiresAuth: string): string => `
entry:
  id: unsafe-probe
  name: Unsafe probe
  via: direct
  directUrl: http://localhost/home
  landingUrlPattern: /home
  sessionType: ${sessionType}
  sessionProbe: { url: /session, okStatus: [200] }
  identityProbe: { url: /identity, jsonPath: $.principal, requiresAuth: ${requiresAuth} }
`;
    expect(() => parseEntry(yaml('cookie', 'false'))).toThrow();
    expect(() => parseEntry(yaml('unknown', 'true'))).toThrow(/sessionType/);
  });

  it('T-93：Authorization 仅允许浏览器运行时占位符', () => {
    const skill = (value: string): string => `
skill: { id: header, name: header, system: test, baseUrl: http://localhost, entry: oa }
params: []
steps:
  - id: s1
    desc: submit
    channel: network
    network:
      method: POST
      url: /submit
      headers: { Authorization: "${value}" }
`;
    expect(() => parseSkill(skill('<FROM_BROWSER>'), entryResolver(testEntry()))).not.toThrow();
    expect(() => parseSkill(skill('Bearer eyJ.live.token'), entryResolver(testEntry()))).toThrow(
      /Authorization|凭证/,
    );
  });
});
