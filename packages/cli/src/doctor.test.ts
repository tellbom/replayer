import { describe, expect, it } from 'vitest';

import { frontendConclusion } from './doctor.js';

describe('T-22 前端框架探测结论', () => {
  it('Vue2 + Element UI 启用条件任务', () => {
    expect(frontendConclusion({ vue: 2, ui: 'element-ui', evidence: [] })).toContain('需启用');
  });

  it('Vue3 + Element Plus 不启用 Vue2 条件任务', () => {
    expect(frontendConclusion({ vue: 3, ui: 'element-plus', evidence: [] })).toContain('无需启用');
  });
});
