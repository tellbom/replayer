import { parseSkill } from '@dsh/core';
import type { Entry, ILLMProvider, Skill } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { annotate } from './annotate.js';

const testEntry: Entry = {
  entry: {
    id: 'oa', name: 'OA', via: 'direct', directUrl: 'http://oa/login',
    landingUrlPattern: '/home', excludeUrlPatterns: [], sessionType: 'cookie',
    sessionProbe: { url: '/api/session', okStatus: [200] },
    identityProbe: { url: '/api/userinfo', jsonPath: '$.sub', requiresAuth: true },
    sessionHolding: {
      strategy: 'daemon', probeIntervalMs: 30_000, stateTtlMs: 1_800_000,
      cookieKind: 'unknown',
    },
    loginUrlPatterns: [], loginTimeoutMs: 300_000,
    credentialProvider: { type: 'none', ref: '', ttlMs: 30_000 },
  },
};

const draft: Skill = {
  skill: {
    id: 'draft',
    name: '草稿',
    system: 'oa',
    baseUrl: 'http://oa',
    entry: 'oa',
    version: 1,
  },
  params: [{ name: 'reason', type: 'string', required: true }],
  preflight: [],
  steps: [{ id: 's1', desc: '点击', channel: 'ui', riskLevel: 'read', hasSideEffect: false, requires: [] }],
  assertions: [],
  verification: { status: 'draft', requiresFirstRunVerification: false, verifiedAt: null, verifiedRunId: null, verifiedBy: null, verifiedTtlDays: 30, rerecordReason: null },
};

describe('annotate', () => {
  it('生成仍可解析且所有 LLM 产出均带 TODO 的草稿', async () => {
    const llm: ILLMProvider = {
      name: 'mock',
      supportsVision: false,
      async chat() {
        return JSON.stringify({
          skill: { id: 'oa_submit', name: '提交申请', description: '提交 OA 申请' },
          params: [{ name: 'reason', prompt: '申请事由' }],
          steps: [{ id: 's1', desc: '点击提交按钮' }],
          assertions: [{ type: 'textPresent', expect: '提交成功' }],
          warnings: ['该流程包含写操作'],
        });
      },
    };

    const result = await annotate(llm, draft);
    expect(parseSkill(result.yaml, () => testEntry)).toEqual(result.skill);
    expect((result.yaml.match(/# TODO: LLM 建议/g) ?? []).length).toBe(7);
    expect(result.skill.steps[0]?.desc).toBe('点击提交按钮');
  });
});
