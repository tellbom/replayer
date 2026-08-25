export type LocatorStrategy =
  | { strategy: 'el-form-item'; label: string; kind: ControlKind }
  | { strategy: 'el-option'; text: string; ownerLabel: string }
  | { strategy: 'el-dialog-scoped'; dialogTitle: string; inner: LocatorStrategy }
  | { strategy: 'el-table-cell'; rowAnchorText: string; buttonText: string }
  | { strategy: 'text'; text: string; exact?: boolean; nth?: number }
  | { strategy: 'role'; role: string; name: string }
  | { strategy: 'css'; selector: string }
  /**
   * 【T-67a】Playwright selectorGenerator 产物（vendor 引擎语法，如
   * internal:role=button[name="x"i] >> nth=1）。由 Node 侧 Playwright
   * Locator API 解析执行（channel-ui），不进浏览器 IIFE。
   */
  | { strategy: 'playwright'; selector: string; confidence?: 'HIGH' | 'LOW' }
  | {
      strategy: 'frame-playwright';
      frame: string;
      selector: string;
      confidence?: 'HIGH' | 'LOW';
    };

export type ControlKind =
  'input' | 'textarea' | 'select' | 'datepicker' | 'radio' | 'checkbox' | 'button' | 'text';

export interface RecordedHint {
  action: 'click' | 'fill' | 'select' | 'check' | 'datetime' | 'navigate';
  visibleText: string | null;
  visibleTextSource:
    | 'accessible-name' | 'label' | 'aria' | 'placeholder' | 'title' | 'text'
    | 'control-semantics' | 'adjacent-text' | 'none';
  controlSemantics: {
    tagName: string;
    type: string | null;
    name: string | null;
    value: string | null;
    checked: boolean | null;
  } | null;
  tagName: string;
  role: string | null;
  matchCountAtRecord: number;
}

export interface AppearedRoot {
  node: Element;
  descriptor: LocatorStrategy;
  appearedAfterMs: number;
  kind: 'dialog' | 'drawer' | 'listbox' | 'menu' | 'datepicker' | 'table-row' | 'panel' | 'unknown';
  portaled: boolean;
}

export type AppearedRootRecord = Omit<AppearedRoot, 'node'>;

export interface ScopeDefinition {
  scopeId: string;
  root: LocatorStrategy;
  kind: AppearedRoot['kind'];
  portaled: boolean;
  appearedAfterMs?: number;
}

export interface RecordSession {
  meta: {
    startedAt: string;
    endedAt: string;
    baseUrl: string;
    userAgent: string;
    /** 【v2.0】本次录制使用的 entry 配置 id */
    entryId: string;
    identityChanged?: boolean;
  };
  actions: RecordedAction[];
  network: RecordedRequest[];
  pages: { ts: number; url: string; title: string }[];
  interruptions?: SessionInterrupt[];
  initialFormState?: RecordedFormState[];
  pageSnapshots?: PageSnapshot[];
}

export interface PageSnapshot {
  ts: number;
  url: string;
  actionIdx: number | null;
  immutableValues: Array<{
    locator: LocatorStrategy;
    value: string;
    kind: 'hidden' | 'readonly' | 'disabled' | 'meta' | 'untouched';
  }>;
}

export interface RecordedFormState {
  ts: number;
  type: 'select' | 'radio' | 'checkbox';
  target: LocatorStrategy;
  label?: string;
  name?: string;
  value: string;
  text?: string;
  checked?: boolean;
}

export interface SessionInterrupt {
  type: 'session-interrupt';
  atActionIdx: number;
  detectedAt: string;
  resumedAt?: string;
  identityChanged?: boolean;
}

export interface RecordedAction {
  ts: number;
  type: 'click' | 'fill' | 'select' | 'radio' | 'checkbox' | 'datetime' | 'navigate';
  target?: LocatorStrategy;
  recordedHint?: RecordedHint;
  label?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  text?: string;
  enumOptions?: {
    items: Array<{ label: string; value: string }>;
    complete: boolean;
    incompleteReason?: 'truncated' | 'dynamic-loading' | 'partial-dom';
  };
  url?: string;
  scope?: string;
  produces?: ScopeDefinition;
  waitAfter?: {
    scopeReady?: string;
    urlPattern?: string;
    networkIdle?: boolean;
    requestUrlPattern?: string;
    notEmpty?: LocatorStrategy;
    settleMs?: number;
    timeoutMs?: number;
  };
}

export type SanitizeMode = 'structured' | 'fallback' | 'none';

export interface ActiveAction {
  actionIdx: number;
  targetKey: string;
  target: LocatorStrategy;
  kind: 'input' | 'click' | 'select' | 'check';
  value: string | null;
  startedAt: number;
  touchedAt: number;
  blurAt: number | null;
}

export interface RecordedRequest {
  requestId: string;
  requestTs: number;
  responseTs: number | null;
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  postData: string | null;
  status: number | null;
  responseBody: string | null;
  mutating: boolean;
  sanitizeMode: SanitizeMode;
  actionIdx: number | null;
  causality: 'active-action' | 'none';
  causalityDebug: {
    targetKey: string;
    kind: string;
    valueAtRequest: string | null;
    msSinceTouched: number;
  } | null;
  networkError?: string;
}

export type AuthState = 'authenticated' | 'unauthenticated' | 'forbidden' | 'unknown';

export type ExecutionOutcome =
  'not_sent' | 'confirmed_success' | 'confirmed_failure' | 'outcome_unknown';

export interface ExecContext {
  // 冻结契约允许保存任意参数与步骤返回值。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vars: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stepResults: Record<string, any>;
  baseUrl: string;
  /** 【v2.0】技能引用的认证载体配置 */
  entry: import('./schema.js').Entry;
  /** 【C21】执行开始时记录的身份摘要 */
  identityDigest: string;
  scopes: Record<string, ScopeDefinition>;
}

export interface StepResult {
  stepId: string;
  ok: boolean;
  outcome: ExecutionOutcome;
  channelUsed: 'network' | 'ui' | 'merged';
  durationMs: number;
  error?: string;
  healed?: boolean;
  raw?: { status?: number; text?: string };
  outcomeResolvedBy?: 'response' | 'postcondition';
  postconditionResult?: {
    found: boolean;
    expectFound: boolean;
    matched?: unknown;
  };
}

export interface RunResult {
  ok: boolean;
  skillId: string;
  steps: StepResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extracted: Record<string, any>;
  /** 【v2.0 C22】本次运行触发的重入次数 */
  reentryCount: number;
  diagnosticDir?: string;
}

export interface HealCandidate {
  stepId: string;
  oldTarget: LocatorStrategy;
  newTarget: LocatorStrategy;
  resolveVerified: boolean;
  actionVerified: boolean;
  requiresConfirm: boolean;
  model: string;
}

export interface ILLMProvider {
  name: string;
  supportsVision: boolean;
  chat(
    messages: LLMMessage[],
    opts?: { jsonSchema?: object; temperature?: number; maxTokens?: number },
  ): Promise<string>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

declare global {
  interface Window {
    __DSH_LOCATOR__: {
      byFormItem(label: string, kind: ControlKind): HTMLElement;
      selectOption(label: string, optionText: string): Promise<void>;
      setDateTime(label: string, value: string): Promise<void>;
      inDialog<T>(title: string, fn: (dialog: HTMLElement) => T): Promise<T>;
      tableRowButton(rowAnchorText: string, buttonText: string): HTMLElement;
      resolve(strategy: LocatorStrategy): Promise<HTMLElement>;
      robustClick(element: HTMLElement): void;
      setInputValue(element: HTMLElement, value: string): void;
      waitFor<T>(fn: () => T, timeout?: number): Promise<T>;
      version(): 'element-plus' | 'element-ui';
    };
    __DSH_SNAPSHOT__: () => string;
    __DSH_PWGEN__: (element: Element) => {
      selector: string;
      unique: boolean;
      matchCount: number;
      confidence: 'HIGH' | 'LOW';
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __DSH_RECORD__?: (action: any) => void;
    __DSH_ACTIVE_ACTION__?: ActiveAction | null;
    __DSH_ACTIVE_ACTION_UPDATE__?: (action: ActiveAction | null) => void;
    __DSH_RECORD_INITIAL_STATE__?: (state: RecordedFormState) => void;
    __DSH_INITIAL_FORM_STATE__?: () => void;
    __DSH_RECORDING__?: boolean;
    __dsh_clicked__?: Record<number, Element>;
    __DSH_MUTATION__: {
      begin(actionIdx: number): void;
      end(actionIdx: number, settleMs?: number): Promise<AppearedRoot[]>;
      deriveScope(
        producerActionIdx: number,
        target: Element,
      ): { root: AppearedRootRecord; target: LocatorStrategy } | null;
    };
    __DSH_ANCESTOR_SCOPE__: (element: Element) => {
      scopeSelector: string;
      targetSelector: string;
      targetConfidence: 'HIGH' | 'LOW';
    } | null;
    __DSH_EXTRACT_RECORDED_HINT__: (
      element: Element,
      action: RecordedHint['action'],
      matchCountAtRecord: number,
    ) => RecordedHint;
  }
}
