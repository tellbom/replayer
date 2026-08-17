import { createHash, randomBytes } from 'node:crypto';

import type { SanitizeMode } from './types.js';

const SENSITIVE_HEADER =
  /^(authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-csrf-token)$/i;
const SENSITIVE_FIELD =
  /(password|passwd|access_token|refresh_token|token|session|secret|api_key|__VIEWSTATE|__EVENTVALIDATION|__RequestVerificationToken)/i;

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
