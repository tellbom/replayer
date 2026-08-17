import { AssertionFailedError } from '@dsh/core';
import type { ExecContext, Skill } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { runAssertions } from './assert.js';

describe('runAssertions', () => {
  it('accepts the expected HTTP status', () => {
    expect(() => run([{ type: 'httpStatus', expect: 201 }], { status: 201 })).not.toThrow();
  });

  it('rejects an unexpected HTTP status', () => {
    expect(() => run([{ type: 'httpStatus', expect: 201 }], { status: 400 })).toThrow(
      AssertionFailedError,
    );
  });

  it('accepts an equal JSONPath value', () => {
    expect(() =>
      run([{ type: 'jsonPath', path: '$.data.items[0].code', expect: 0 }], {
        text: '{"data":{"items":[{"code":0}]}}',
      }),
    ).not.toThrow();
  });

  it('rejects a different JSONPath value', () => {
    expect(() =>
      run([{ type: 'jsonPath', path: '$.data.code', expect: 0 }], {
        text: '{"data":{"code":1}}',
      }),
    ).toThrow(AssertionFailedError);
  });

  it('accepts text containing the expected fragment', () => {
    expect(() =>
      run([{ type: 'textPresent', expect: '提交成功' }], { text: '申请提交成功：OT-1' }),
    ).not.toThrow();
  });

  it('rejects text without the expected fragment', () => {
    expect(() =>
      run([{ type: 'textPresent', expect: '提交成功' }], { text: '提交失败' }),
    ).toThrow(AssertionFailedError);
  });

  it('extracts the first regex capture into context variables', () => {
    const context = makeContext();
    runAssertions(
      [{ type: 'regexExtract', pattern: '单号：(OT-[0-9]+)', name: 'submissionNo' }],
      { text: '提交成功，单号：OT-1024' },
      context,
    );
    expect(context.vars.submissionNo).toBe('OT-1024');
  });

  it('rejects text that does not match the extraction regex', () => {
    expect(() =>
      run(
        [{ type: 'regexExtract', pattern: '单号：(OT-[0-9]+)', name: 'submissionNo' }],
        { text: '提交失败' },
      ),
    ).toThrow(AssertionFailedError);
  });
});

function run(assertions: Skill['assertions'], raw: { status?: number; text?: string }): void {
  runAssertions(assertions, raw, makeContext());
}

function makeContext(): ExecContext {
  return { params: {}, vars: {}, stepResults: {}, baseUrl: 'http://127.0.0.1' };
}
