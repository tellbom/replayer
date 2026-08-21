import { describe, expect, it } from 'vitest';

import { LocatorStrategySchema, SkillSchema, StepSchema } from './schema.js';

describe('T-71 scope 契约', () => {
  it('保留原字段并填充 requires、portaled、timeoutMs 默认值', () => {
    const step = StepSchema.parse({
      id: 's1',
      desc: '打开确认框',
      channel: 'ui',
      ui: {
        action: 'click',
        scope: 'sc1',
        target: { strategy: 'playwright', selector: 'internal:role=button[name="确定"i]' },
      },
      produces: {
        scopeId: 'sc2',
        root: { strategy: 'playwright', selector: 'internal:role=dialog[name="确认"i]' },
        kind: 'dialog',
      },
      waitAfter: { scopeReady: 'sc2' },
    });

    expect(step.requires).toEqual([]);
    expect(step.produces?.portaled).toBe(false);
    expect(step.waitAfter?.timeoutMs).toBe(8_000);
    expect(step.ui?.scope).toBe('sc1');
  });
});

describe('T-76 sessionHolding 契约', () => {
  it('使用 daemon 主路径默认值', async () => {
    const { parseEntry } = await import('./schema.js');
    const entry = parseEntry(`entry:
  id: oa
  name: OA
  via: direct
  directUrl: http://oa/home
  landingUrlPattern: /home
  sessionProbe: { url: /api/session, okStatus: [200] }
  identityProbe: { url: /api/userinfo, jsonPath: $.sub }
`);
    expect(entry.entry.sessionHolding).toEqual({
      strategy: 'daemon',
      probeIntervalMs: 30_000,
      stateTtlMs: 1_800_000,
      cookieKind: 'unknown',
    });
  });
});

describe('T-73 iframe 定位契约', () => {
  it('解析 frame-playwright target', () => {
    expect(
      LocatorStrategySchema.parse({
        strategy: 'frame-playwright',
        frame: '#legacy',
        selector: 'button[name="提交"]',
        confidence: 'HIGH',
      }),
    ).toMatchObject({ strategy: 'frame-playwright', frame: '#legacy' });
  });
});

describe('T-79 LOW 与 Skill 验证契约', () => {
  it('保留 LOW recordedHint 并默认进入 draft', () => {
    const skill = SkillSchema.parse({
      skill: { id: 'low', name: 'LOW', system: 'oa', baseUrl: 'http://oa', entry: 'oa' },
      params: [],
      steps: [{
        id: 's1', desc: '填写', channel: 'ui',
        ui: {
          action: 'fill',
          target: { strategy: 'playwright', selector: 'internal:role=textbox >> nth=5', confidence: 'LOW' },
          recordedHint: {
            action: 'fill', visibleText: '开始时间', visibleTextSource: 'accessible-name',
            tagName: 'input', role: 'textbox', matchCountAtRecord: 1,
          },
        },
      }],
    });
    expect(skill.verification).toEqual({
      status: 'draft', requiresFirstRunVerification: false,
      verifiedAt: null, verifiedRunId: null, verifiedBy: null,
      verifiedTtlDays: 30, rerecordReason: null,
    });
    expect(skill.steps[0]?.ui?.recordedHint?.visibleText).toBe('开始时间');
  });
});
