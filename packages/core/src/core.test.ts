import { describe, expect, it } from 'vitest';

import {
  AssertionFailedError,
  ForbiddenError,
  LLMValidationError,
  LocatorNotFoundError,
  LoginTimeoutError,
  OutcomeUnknownError,
  SchemaViolationError,
  StepExecutionError,
} from './errors.js';
import { assertNoPlainCredentials, createSanitizer } from './sanitize.js';

describe('统一脱敏器', () => {
  it('脱敏认证与会话 header，同时保留普通 header', () => {
    const sanitizer = createSanitizer();
    const result = sanitizer.sanitizeHeaders({
      Authorization: 'Bearer secret-a',
      Cookie: 'sid=secret-b',
      'Set-Cookie': 'sid=secret-c',
      'X-CSRF-TOKEN': 'secret-csrf',
      'Content-Type': 'application/json',
    });

    expect(result.Authorization).toMatch(/^<REDACTED:sha256:[0-9a-f]{12}>$/);
    expect(result.Cookie).toMatch(/^<REDACTED:sha256:[0-9a-f]{12}>$/);
    expect(result['Set-Cookie']).toMatch(/^<REDACTED:sha256:[0-9a-f]{12}>$/);
    expect(result['X-CSRF-TOKEN']).toMatch(/^<REDACTED:sha256:[0-9a-f]{12}>$/);
    expect(result['Content-Type']).toBe('application/json');
  });

  it('递归脱敏 password 和嵌套 token，不修改普通业务字段', () => {
    const sanitizer = createSanitizer();
    const source = {
      username: 'zhangsan',
      password: 'secret-password',
      nested: { access_token: 'secret-token', reason: '版本上线' },
    };
    const result = sanitizer.sanitizeObject(source);

    expect(result.password).toMatch(/^<REDACTED:sha256:/);
    expect(result.nested.access_token).toMatch(/^<REDACTED:sha256:/);
    expect(result.username).toBe('zhangsan');
    expect(result.nested.reason).toBe('版本上线');
    expect(source.password).toBe('secret-password');
  });

  it('同会话相同 secret 指纹相同，不同 secret 指纹不同', () => {
    const sanitizer = createSanitizer();

    expect(sanitizer.fingerprint('same-token')).toBe(sanitizer.fingerprint('same-token'));
    expect(sanitizer.fingerprint('first-token')).not.toBe(sanitizer.fingerprint('second-token'));
  });

  it('sanitizeText 处理嵌套 JSON 字符串中的转义 token 字段', () => {
    const sanitizer = createSanitizer();
    // StepResult.raw.text 这类字段持有「字符串形式的响应体」，
    // 序列化后敏感字段以 \"access_token\":\"...\" 双层转义形态出现。
    const embedded = JSON.stringify({
      raw: { text: JSON.stringify({ access_token: 'secret-jwt-payload' }) },
    });

    const result = sanitizer.sanitizeText(embedded);
    expect(result).not.toContain('secret-jwt-payload');
    expect(result).toMatch(/<REDACTED:sha256:[0-9a-f]{12}>/);
  });

  it('双层转义的 JWT 必须被脱敏（Keycloak 实测回归）', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.sig';
    const inner = JSON.stringify({ access_token: jwt, expires_in: 60 });
    const outer = JSON.stringify({ status: 200, text: inner });
    const out = createSanitizer().sanitizeBody(outer, 'application/json');
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9');
  });

  it('三层嵌套同样不得泄漏', () => {
    const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.sig';
    const level3 = JSON.stringify({ access_token: jwt });
    const level2 = JSON.stringify({ payload: level3 });
    const level1 = JSON.stringify({ body: level2 });
    const out = createSanitizer().sanitizeBody(level1, 'application/json');
    expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9');
    expect(out).toMatch(/<REDACTED:sha256:[0-9a-f]{12}>/);
  });

  it('正常业务字段不被误伤', () => {
    const out = createSanitizer().sanitizeBody(
      JSON.stringify({ passengerName: '张三', secretary: '李四' }),
      'application/json',
    );
    expect(out).toContain('张三');
    expect(out).toContain('李四');
  });

  it('assertNoPlainCredentials 拦截 grant_type=password 与凭证字段名', () => {
    expect(() =>
      assertNoPlainCredentials({ body: 'grant_type=password&username=a' }),
    ).toThrow(SchemaViolationError);
    expect(() =>
      assertNoPlainCredentials({ body: JSON.stringify({ grant_type: 'password' }) }),
    ).toThrow(SchemaViolationError);
    expect(() => assertNoPlainCredentials({ steps: [{ body: { password: 'x' } }] })).toThrow(
      SchemaViolationError,
    );
    expect(() => assertNoPlainCredentials({ steps: [{ body: { client_secret: 'y' } }] })).toThrow(
      SchemaViolationError,
    );
    // 正常业务字段通过
    expect(() =>
      assertNoPlainCredentials({ steps: [{ body: { reason: '版本上线', type: 'workday' } }] }),
    ).not.toThrow();
  });

  it('跨编码格式的同一 token 产生相同 fingerprint', () => {
    const token = 'tk_9f3a2c8e1b';
    const sanitizer = createSanitizer();
    const response = sanitizer.sanitizeBody(
      JSON.stringify({ approverId: 1023, approvalToken: token }),
      'application/json',
    );
    const request = sanitizer.sanitizeBody(
      `type=workday&approverId=1023&approvalToken=${token}`,
      'application/x-www-form-urlencoded',
    );

    const responseFingerprint = JSON.parse(response).approvalToken as string;
    const requestFingerprint = new URLSearchParams(request).get('approvalToken');
    expect(responseFingerprint).toMatch(/^<REDACTED:sha256:[0-9a-f]{12}>$/);
    expect(requestFingerprint).toBe(responseFingerprint);
  });

  it('URL query 中的 token 使用相同 fingerprint，普通参数保留', () => {
    const token = 'tk_9f3a2c8e1b';
    const sanitizer = createSanitizer();
    const expected = sanitizer.fingerprint(token);
    const result = sanitizer.sanitizeUrl(`/api/x?approvalToken=${token}&type=workday`);
    const query = new URL(result, 'http://localhost').searchParams;

    expect(query.get('approvalToken')).toBe(expected);
    expect(query.get('type')).toBe('workday');
  });

  it('结构化处理 multipart 与 HTML hidden 字段', () => {
    const sanitizer = createSanitizer();
    const multipart = [
      '--dsh-boundary',
      'Content-Disposition: form-data; name="approvalToken"',
      '',
      'secret-token',
      '--dsh-boundary--',
      '',
    ].join('\r\n');
    const multipartResult = sanitizer.sanitizeBodyWithMode(
      multipart,
      'multipart/form-data; boundary=dsh-boundary',
    );
    const htmlResult = sanitizer.sanitizeBodyWithMode(
      '<input type="hidden" name="__VIEWSTATE" value="secret-state"><input name="reason" value="版本上线">',
      'text/html',
    );

    expect(multipartResult.sanitizeMode).toBe('structured');
    expect(multipartResult.value).not.toContain('secret-token');
    expect(htmlResult.sanitizeMode).toBe('structured');
    expect(htmlResult.value).not.toContain('secret-state');
    expect(htmlResult.value).toContain('版本上线');
  });

  it('无法按声明的结构解析时标记 fallback', () => {
    const result = createSanitizer().sanitizeBodyWithMode(
      '{"approvalToken":"secret-token"',
      'application/json',
    );

    expect(result.sanitizeMode).toBe('fallback');
    expect(result.value).not.toContain('secret-token');
  });

  it('缓存响应缺少 content-type 时仍结构化处理有效 JSON', () => {
    const result = createSanitizer().sanitizeBodyWithMode(
      '{"token":"secret-token"}',
      '',
    );

    expect(result.sanitizeMode).toBe('structured');
    expect(result.value).not.toContain('secret-token');
  });
});

describe('错误代码契约', () => {
  it.each([
    [LocatorNotFoundError, 'LOCATOR_NOT_FOUND'],
    [LoginTimeoutError, 'LOGIN_TIMEOUT'],
    [AssertionFailedError, 'ASSERTION_FAILED'],
    [LLMValidationError, 'LLM_VALIDATION_FAILED'],
    [StepExecutionError, 'STEP_EXECUTION_FAILED'],
    [OutcomeUnknownError, 'OUTCOME_UNKNOWN'],
    [ForbiddenError, 'FORBIDDEN'],
  ])('%s 暴露稳定 code', (ErrorClass, code) => {
    expect(new ErrorClass('测试错误').code).toBe(code);
  });
});
