import { describe, expect, it } from 'vitest';

import { classifyApiError } from './api';

describe('T-06 API 错误分类', () => {
  it('401 跳登录', () => {
    expect(classifyApiError(401)).toBe('login');
  });

  it('403 只显示无权限，不跳登录', () => {
    expect(classifyApiError(403)).toBe('forbidden');
  });

  it('其他错误继续抛给调用方', () => {
    expect(classifyApiError(500)).toBe('propagate');
  });
});
