export const TIMEOUTS = {
  waitForDefault: 5_000,
  selectPanel: 3_000,
  dialogAnimation: 200,
  afterSelect: 120,
  afterDateTime: 100,
  navigation: 30_000,
  /** 【v2.0】导航稳定判定：URL 保持不变多久才认为 SSO 跳转结束 */
  navigationSettle: 1_500,
  navigationSettleMax: 30_000,
  loginPoll: 1_500,
  loginTotal: 300_000,
  networkStep: 15_000,
  /** 【v2.0】entry 探测与 bearer 就地取用 */
  entryProbe: 10_000,
  bearerFetch: 3_000,
} as const;

export const RETRY = {
  stepMax: 2,
  healMax: 2,
  llmSchemaMax: 3,
  exploreMaxSteps: 20,
} as const;

/** 【v2.0】依赖识别的弱值过滤阈值（T-29） */
export const DEPENDENCY = {
  /** 某值在所有响应中出现次数超过该数即视为弱值 */
  weakValueThreshold: 3,
  /** 短字符串不参与依赖匹配 */
  minStringLength: 6,
  /** 绝对值小于该数的整数不参与依赖匹配 */
  minNumberAbs: 1000,
} as const;

/** Browser-observed action/request causality windows. */
export const CAUSALITY = {
  activeWindowMs: 1_500,
  blurGraceMs: 300,
} as const;

export const IDENTIFIER_STABILITY = {
  minEntropySegmentLength: 6,
  minCharsetDiversity: 2,
} as const;

export const ENUM_CAPTURE = {
  maxOptions: 200,
} as const;

export const CANONICAL_CAPTURE = {
  maxAffected: 20,
  maxInnerHTMLLength: 8_192,
  mutationSettleMs: 800,
  pointerMergeGraceMs: 250,
} as const;

export const NOISE_PATTERNS: RegExp[] = [
  /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i,
  /\/(heartbeat|ping|track|collect|analytics|log|sockjs|__vite)/i,
];
