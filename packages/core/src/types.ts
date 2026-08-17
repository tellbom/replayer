export type LocatorStrategy =
  | { strategy: 'el-form-item'; label: string; kind: ControlKind }
  | { strategy: 'el-option'; text: string; ownerLabel: string }
  | { strategy: 'el-dialog-scoped'; dialogTitle: string; inner: LocatorStrategy }
  | { strategy: 'el-table-cell'; rowAnchorText: string; buttonText: string }
  | { strategy: 'text'; text: string; exact?: boolean; nth?: number }
  | { strategy: 'role'; role: string; name: string }
  | { strategy: 'css'; selector: string };

export type ControlKind =
  | 'input'
  | 'textarea'
  | 'select'
  | 'datepicker'
  | 'radio'
  | 'checkbox'
  | 'button'
  | 'text';

export interface RecordSession {
  meta: { startedAt: string; endedAt: string; baseUrl: string; userAgent: string };
  actions: RecordedAction[];
  network: RecordedRequest[];
  pages: { ts: number; url: string; title: string }[];
}

export interface RecordedAction {
  ts: number;
  type: 'click' | 'fill' | 'select' | 'datetime' | 'navigate';
  target?: LocatorStrategy;
  label?: string;
  value?: string;
  text?: string;
  url?: string;
}

export type SanitizeMode = 'structured' | 'fallback' | 'none';

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
  networkError?: string;
}

export type AuthState = 'authenticated' | 'unauthenticated' | 'forbidden' | 'unknown';

export type ExecutionOutcome =
  | 'not_sent'
  | 'confirmed_success'
  | 'confirmed_failure'
  | 'outcome_unknown';

export interface ExecContext {
  // 冻结契约允许保存任意参数与步骤返回值。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  params: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vars: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stepResults: Record<string, any>;
  baseUrl: string;
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
}

export interface RunResult {
  ok: boolean;
  skillId: string;
  steps: StepResult[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extracted: Record<string, any>;
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
    __DSH_GEN__: (element: Element) => LocatorStrategy;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    __DSH_RECORD__?: (action: any) => void;
    __DSH_RECORDING__?: boolean;
  }
}
