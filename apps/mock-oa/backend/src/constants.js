export const DELAY = {
  minMs: 300,
  maxMs: 800,
};

export const SESSION = {
  cookieName: 'MOCK_OA_SID',
  secret: 'mock-oa-session-secret',
  /** 模拟持久门户会话（跨浏览器重启存活，供 ensureEntry 复用） */
  maxAgeMs: 24 * 60 * 60 * 1_000,
};

export const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1_000;
