import { createHash, randomBytes } from 'node:crypto';

import { SchemaViolationError } from './errors.js';
import type { SanitizeMode } from './types.js';

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-csrf-token)$/i;
// 敏感词词形匹配：camel/snake 变体均命中（approvalToken、client_secret、api_key），
// 仅排除同词内的小写延续（secretary、tokenize）这类业务字段误伤。
const SENSITIVE_FIELD =
  /(?:[Pp]assword|[Pp]asswd|[Aa]ccess_?[Tt]oken|[Rr]efresh_?[Tt]oken|[Tt]oken|[Ss]ession|[Ss]ecret|[Aa]pi_?[Kk]ey)(?![a-z])|__VIEWSTATE|__EVENTVALIDATION|__RequestVerificationToken/;

export interface SanitizedBody {
  value: string;
  sanitizeMode: SanitizeMode;
}

export interface Sanitizer {
  fingerprint(value: string): string;
  sanitizeHeaders(headers: Record<string, string>): Record<string, string>;
  sanitizeObject<T>(value: T): T;
  sanitizeBody(body: string, contentType: string): string;
  sanitizeBodyWithMode(body: string, contentType: string): SanitizedBody;
  sanitizeUrl(url: string): string;
  sanitizeText(text: string): string;
}

export function createSanitizer(): Sanitizer {
  const salt = randomBytes(32);

  const fingerprint = (value: string): string => {
    const digest = createHash('sha256').update(salt).update(value).digest('hex').slice(0, 12);
    return `<REDACTED:sha256:${digest}>`;
  };

  const sanitizeUnknown = (value: unknown, key?: string): unknown => {
    if (key !== undefined && SENSITIVE_FIELD.test(key)) {
      return fingerprint(String(value));
    }
    // 【v2.0 规格第 5 条】字符串叶子可能是内嵌 JSON（如 StepResult.raw.text 持有的
    // 响应体）。先尝试 JSON.parse 展开，成功则递归处理后再序列化回去；
    // 失败则保持原值（非 JSON 字符串的脱敏由 sanitizeText 的正则兜底）。
    if (typeof value === 'string' && looksLikeJson(value)) {
      try {
        return sanitizeUnknown(JSON.parse(value));
      } catch {
        // 保持原值继续
      }
    }
    if (Array.isArray(value)) {
      return value.map((item) => sanitizeUnknown(item));
    }
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, childValue]) => [
          childKey,
          sanitizeUnknown(childValue, childKey),
        ]),
      );
    }
    return value;
  };

  const sanitizeHeaders = (headers: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [
        key,
        SENSITIVE_HEADER.test(key) ? fingerprint(value) : value,
      ]),
    );

  const sanitizeObject = <T>(value: T): T => sanitizeUnknown(value) as T;

  const sanitizeText = (text: string): string =>
    text
      .replace(
        /(([\w.-]*(?:password|passwd|access_token|refresh_token|token|session|secret|api_key)[\w.-]*)\s*[=:]\s*["']?)([^\s,"'&}]+)/gi,
        (_match, prefix: string, _key: string, value: string) => `${prefix}${fingerprint(value)}`,
      )
      .replace(
        /("[^"]*(?:password|passwd|access_token|refresh_token|token|session|secret|api_key)[^"]*"\s*:\s*")([^"]*)(")/gi,
        (_match, prefix: string, value: string, suffix: string) =>
          `${prefix}${fingerprint(value)}${suffix}`,
      )
      // 嵌套 JSON 字符串：字段以 \"key\":\"value\" 双层转义形态出现
      //（如诊断包 result.json 里 StepResult.raw.text 持有的响应体）。
      .replace(
        /(\\?"[^"\\]*(?:password|passwd|access_token|refresh_token|token|session|secret|api_key)[^"\\]*\\?"\s*:\s*\\?")([^"\\]*)(\\?")/gi,
        (_match, prefix: string, value: string, suffix: string) =>
          `${prefix}${fingerprint(value)}${suffix}`,
      );

  const sanitizeBodyWithMode = (body: string, contentType: string): SanitizedBody => {
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase();
    try {
      if (mediaType === 'application/json' || mediaType?.endsWith('+json')) {
        return { value: JSON.stringify(sanitizeUnknown(JSON.parse(body))), sanitizeMode: 'structured' };
      }
      if (mediaType === 'application/x-www-form-urlencoded') {
        const params = new URLSearchParams(body);
        for (const [key, value] of params) {
          if (SENSITIVE_FIELD.test(key)) params.set(key, fingerprint(value));
        }
        return { value: params.toString(), sanitizeMode: 'structured' };
      }
      if (mediaType === 'multipart/form-data') {
        const boundary = getBoundary(contentType);
        return {
          value: sanitizeMultipart(body, boundary, fingerprint),
          sanitizeMode: 'structured',
        };
      }
      if (mediaType === 'text/html') {
        return { value: sanitizeHiddenInputs(body, fingerprint), sanitizeMode: 'structured' };
      }
      if (body.length === 0) return { value: body, sanitizeMode: 'none' };
    } catch {
      return { value: sanitizeText(body), sanitizeMode: 'fallback' };
    }
    return { value: sanitizeText(body), sanitizeMode: 'fallback' };
  };

  const sanitizeBody = (body: string, contentType: string): string =>
    sanitizeBodyWithMode(body, contentType).value;

  const sanitizeUrl = (url: string): string => {
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) return url;
    const fragmentIndex = url.indexOf('#', queryIndex);
    const base = url.slice(0, queryIndex);
    const query = url.slice(queryIndex + 1, fragmentIndex === -1 ? undefined : fragmentIndex);
    const fragment = fragmentIndex === -1 ? '' : url.slice(fragmentIndex);
    const params = new URLSearchParams(query);
    for (const [key, value] of params) {
      if (SENSITIVE_FIELD.test(key)) params.set(key, fingerprint(value));
    }
    return `${base}?${params.toString()}${fragment}`;
  };

  return {
    fingerprint,
    sanitizeHeaders,
    sanitizeObject,
    sanitizeBody,
    sanitizeBodyWithMode,
    sanitizeUrl,
    sanitizeText,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 仅对「看起来像 JSON 对象/数组」的字符串做展开，避免对普通业务文本反复 parse。 */
function looksLikeJson(value: string): boolean {
  return value.length > 1 && (value.startsWith('{') || value.startsWith('['));
}

function getBoundary(contentType: string): string {
  const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) throw new Error('multipart/form-data 缺少 boundary');
  return boundary;
}

function sanitizeMultipart(
  body: string,
  boundary: string,
  fingerprint: (value: string) => string,
): string {
  return body
    .split(`--${boundary}`)
    .map((part) => {
      const name = /name="([^"]+)"/i.exec(part)?.[1];
      if (!name || !SENSITIVE_FIELD.test(name)) return part;
      const separator = part.includes('\r\n\r\n') ? '\r\n\r\n' : '\n\n';
      const valueStart = part.indexOf(separator);
      if (valueStart === -1) throw new Error('multipart part 格式无效');
      const contentStart = valueStart + separator.length;
      const trailingNewline = part.endsWith('\r\n') ? '\r\n' : part.endsWith('\n') ? '\n' : '';
      const contentEnd = trailingNewline ? part.length - trailingNewline.length : part.length;
      return `${part.slice(0, contentStart)}${fingerprint(part.slice(contentStart, contentEnd))}${trailingNewline}`;
    })
    .join(`--${boundary}`);
}

function sanitizeHiddenInputs(body: string, fingerprint: (value: string) => string): string {
  return body.replace(/<input\b[^>]*>/gi, (input) => {
    if (!/\btype\s*=\s*["']?hidden["']?/i.test(input)) return input;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(input)?.[1];
    if (!name || !SENSITIVE_FIELD.test(name)) return input;
    return input.replace(
      /(\bvalue\s*=\s*["'])([^"']*)(["'])/i,
      (_match, prefix: string, value: string, suffix: string) =>
        `${prefix}${fingerprint(value)}${suffix}`,
    );
  });
}

/** 【v2.0 C17】凭证字段名黑名单：技能中不得出现明文凭证字段。 */
const FORBIDDEN_KEYS = /^(password|passwd|pwd|secret|client_?secret|credential|api_?key)$/i;
/** 【v2.0 C17】凭证换取语义：grant_type=password 的字符串与表单两种形态。 */
const FORBIDDEN_VALUES = /grant_type\s*=\s*password|"grant_type"\s*:\s*"password"/i;

/**
 * 【C17】递归校验技能树中不含明文凭证。parseSkill 在 Schema 解析后调用，
 * 命中即抛 SchemaViolationError——凭证换取直接否定整个架构的存在理由（§0.3）。
 */
// 冻结契约允许技能树持有任意 JSON 值。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function assertNoPlainCredentials(node: any, path = 'root'): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (FORBIDDEN_VALUES.test(node)) {
      throw new SchemaViolationError(
        `[C17] ${path} 含凭证换取语义（grant_type=password），禁止。技能不得包含登录环节，见 C16。`,
      );
    }
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.test(k)) {
      throw new SchemaViolationError(
        `[C17] ${path}.${k} 是明文凭证字段，禁止出现在技能中。二期自动填充请用 credentialProvider.ref。`,
      );
    }
    assertNoPlainCredentials(v, `${path}.${k}`);
  }
}
