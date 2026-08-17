import { describe, expect, it } from 'vitest';

import { assertBrowserBundle } from './_guard.js';

describe('T-11 浏览器 bundle guard', () => {
  it('接受纯浏览器 IIFE', () => {
    expect(() => assertBrowserBundle('(() => { window.x = 1; })();', 'valid.js')).not.toThrow();
  });

  it.each(['require("fs")', 'process.env.X', 'import x from "x"'])('拒绝 %s', (source) => {
    expect(() => assertBrowserBundle(source, 'invalid.js')).toThrow('浏览器侧禁用内容');
  });
});
