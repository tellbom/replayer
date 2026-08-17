export const TIMEOUTS = {
  waitForDefault: 5_000,
  selectPanel: 3_000,
  dialogAnimation: 200,
  afterSelect: 120,
  afterDateTime: 100,
  navigation: 30_000,
  loginPoll: 1_500,
  loginTotal: 300_000,
  networkStep: 15_000,
} as const;

export const RETRY = {
  stepMax: 2,
  healMax: 2,
  llmSchemaMax: 3,
  exploreMaxSteps: 20,
} as const;

export const NOISE_PATTERNS: RegExp[] = [
  /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i,
  /\/(heartbeat|ping|track|collect|analytics|log|sockjs|__vite)/i,
];
