import type { ILLMProvider, Skill } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { route } from './route.js';

const skill: Skill = {
  skill: {
    id: 'oa-overtime-submit',
    name: '提交加班',
    description: '提交工作日或周末加班申请',
    system: 'oa',
    baseUrl: 'http://localhost:5173',
    entry: 'oa',
    version: 1,
  },
  params: [
    {
      name: 'type',
      type: 'enum',
      values: [
        { label: '工作日加班', value: 'workday' },
        { label: '周末加班', value: 'weekend' },
      ],
      required: true,
    },
    { name: 'reason', type: 'string', required: true },
  ],
  preflight: [],
  steps: [],
  assertions: [],
};

function mockLLM(response: object): ILLMProvider {
  return {
    name: 'mock',
    supportsVision: false,
    async chat() {
      return JSON.stringify(response);
    },
  };
}

describe('route', () => {
  it('命中技能并抽取有原文证据的参数', async () => {
    const result = await route(mockLLM({
      skillId: 'oa-overtime-submit',
      params: { type: '工作日加班', reason: '版本上线' },
      sources: { type: '工作日加班', reason: '版本上线' },
    }), '帮我提交工作日加班，事由是版本上线', [skill]);

    expect(result).toEqual({
      skillId: 'oa-overtime-submit',
      params: { type: '工作日加班', reason: '版本上线' },
      missing: [],
    });
  });

  it('无匹配时返回空路由', async () => {
    await expect(route(mockLLM({ skillId: null, params: {}, sources: {} }), '查询工资', [skill])).resolves.toEqual({
      skillId: null,
      params: {},
      missing: [],
    });
  });

  it('必填参数没有原文来源时标记 missing', async () => {
    const result = await route(mockLLM({
      skillId: 'oa-overtime-submit',
      params: { type: '工作日加班', reason: 'LLM 编造的事由' },
      sources: { type: '工作日加班', reason: 'LLM 编造的事由' },
    }), '提交工作日加班', [skill]);

    expect(result).toEqual({
      skillId: 'oa-overtime-submit',
      params: { type: '工作日加班' },
      missing: ['reason'],
    });
  });

  it('enum 非法值按缺失处理', async () => {
    const result = await route(mockLLM({
      skillId: 'oa-overtime-submit',
      params: { type: '节假日加班', reason: '值班' },
      sources: { type: '节假日加班', reason: '值班' },
    }), '提交节假日加班，事由值班', [skill]);

    expect(result).toEqual({
      skillId: 'oa-overtime-submit',
      params: { reason: '值班' },
      missing: ['type'],
    });
  });
});
