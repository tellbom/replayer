# DSH Recorder · Codex 开发执行计划

> 版本：1.1 ｜ 日期：2026-08-17
> 上游依据：《DSH 技术方向文档 v3.1》
> 本文档是**给编码 Agent（Codex）的执行规格**，非架构讨论文档。
> 每个任务都是一个 PR 粒度的工作单元，包含：依赖、交付文件、实现要点、验收命令、DoD。
> v1.1 修订原则：**不扩展产品范围，只修正执行语义与冻结契约**。重点补齐写操作幂等安全、认证四态、Legacy preflight、全链路脱敏、请求时间关联与自愈提交语义；J4 无技能探索降为 Stretch Goal，不阻塞 Core Demo。

---

## 0. 给 Codex 的全局约定

### 0.1 执行规则

1. **一次只做一个任务**，任务 ID 写进 commit message：`feat(T-12): implement el-locator selectOption`
2. **不得跳过依赖**。任务的 `依赖` 字段列出的任务必须已完成且验收通过
3. **不得擅自引入新依赖**。若确需新增，在 PR 描述中单列一节说明理由
4. **不得修改已冻结的契约**（§2 的类型定义）。若发现契约有问题，停下来提出，不要自行改动
5. **每个任务必须自带测试**，且 `pnpm test` 全绿才算完成
6. **浏览器侧代码**（`packages/locator`）不得使用任何 Node API，不得 import npm 包，必须能独立作为 IIFE 注入
7. **所有超时、重试次数、延迟必须是可配置常量**，不得硬编码在逻辑中间
8. 注释和文档字符串用中文，代码标识符用英文

### 0.2 技术栈（固定，不得替换）

| 项 | 选型 |
|---|---|
| 运行时 | Node.js ≥ 20 |
| 语言 | TypeScript 5.x，`strict: true` |
| 包管理 | pnpm workspace |
| 浏览器自动化 | `playwright` ≥ 1.50 |
| Schema 校验 | `zod` |
| YAML | `yaml`（eemeli/yaml，保留注释能力） |
| 单元测试 | `vitest` |
| E2E 测试 | `@playwright/test` |
| 浏览器侧构建 | `esbuild`（打成 IIFE） |
| CLI | `commander` |
| Mock 前端 | Vue 3 + Element Plus + Vite |
| Mock 前端 v2 | Vue 2.7 + Element UI 2.15 |
| Mock 后端 | Express 4 + express-session |
| LLM SDK | `openai`（DeepSeek 走 OpenAI 兼容端点） |

### 0.3 仓库结构（先建骨架，逐任务填充）

```
dsh-recorder/
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
├── playwright.config.ts
├── .env.example
├── packages/
│   ├── core/                     # 类型、Schema、模板引擎、常量
│   │   └── src/{types,schema,template,constants,errors,sanitize}.ts
│   ├── locator/                  # 浏览器侧脚本（IIFE 产物）
│   │   ├── src/{el-locator,recorder-probe,selector-generator,snapshot}.ts
│   │   └── build.mjs             # esbuild → dist/*.iife.js
│   ├── browser/                  # Playwright 载体 + 认证
│   │   └── src/{context,auth,cdp}.ts
│   ├── recorder/                 # 录制会话
│   │   └── src/{session,network,index}.ts
│   ├── analyzer/                 # 分析 + draft 生成
│   │   └── src/{correlate,params,preflight,draft}.ts
│   ├── replayer/                 # 回放
│   │   └── src/{engine,channel-network,channel-ui,preflight,assert,diagnostic}.ts
│   ├── llm/                      # LLM 主脑
│   │   └── src/{provider,snapshot,route,annotate,heal,explore,guard}.ts
│   └── cli/                      # dsh 命令
│       └── src/{index,record,replay,diff,doctor}.ts
├── apps/mock-oa/
│   ├── frontend/                 # Vue3 + Element Plus
│   ├── frontend-vue2/            # Vue2 + Element UI
│   ├── backend/                  # Express
│   └── docker-compose.yml
├── skills/                       # 技能 YAML 产物
├── runs/                         # 诊断包输出（gitignore）
└── e2e/                          # 验收测试 A1–A12
```

### 0.4 里程碑总览

| 里程碑 | 周 | 任务 | 出口标准 |
|---|---|---|---|
| **M0 骨架** | W1 前半 | T-01 ~ T-03 | `pnpm build` / `pnpm test` / `tsc` 全绿，§2 契约人工确认后冻结 |
| **M1 Mock 环境** | W1 | T-04 ~ T-10 | 朴素选择器脚本**必须失败**；依赖陷阱能阻止跳过 approver |
| **M2 定位器** | W2 | T-11 ~ T-16 | 手写脚本连续 20 次跑通加班流程 |
| **M3 载体与认证** | W3 | T-17 ~ T-22 | 认证四态可区分；会话过期后完成握手，但不擅自重放写操作 |
| **M4 录制器** | W4 | T-23 ~ T-28 | 产出完整且已脱敏的 record.json |
| **M5 分析器** | W5 | T-29 ~ T-34 | 产出 draft.yaml，依赖识别包含动态 approvalToken |
| **M6 回放器** | W6 | T-35 ~ T-42 | 确定性回放通过 A1–A5；`outcome_unknown` 不重复提交 |
| **M7 LLM 主脑 Core** | W7 | T-43 ~ T-48, T-51 | 通过 A6、A9、A11、A12；自愈必须先验证再提交 |
| **M7 Stretch** | W7 可选 | T-49 ~ T-50 | A10 无技能探索与固化；**不阻塞 Core Demo** |
| **M8 验收** | W7 末 | T-52 ~ T-55 | Core 验收全绿；A10 若实现则额外通过 |

---

## 1. 关键设计约束（实现时必须遵守）

| # | 约束 | 原因 |
|---|---|---|
| C1 | **channel 是步骤级属性，不是技能级** | 一个技能天然混搭 network/ui/merged |
| C2 | **network 步骤必须在页面上下文内 `fetch` 执行**，不得用 Node 侧 http 客户端 | Cookie 自动携带、同源无 CORS、内网行为一致 |
| C3 | **全链路不得依赖视觉能力**，`ILLMProvider.supportsVision` 恒可为 false | 内网 DeepSeek 无多模态 |
| C4 | **LLM 自愈必须先 resolve-only 验证；有副作用动作必须重新确认并在 postcondition 通过后才写回 YAML** | 防止“为验证而执行”及静默污染 |
| C5 | **LLM 探索只能从固定动作集选择**，输出过三重校验；J4 属于 Stretch Goal | 防止不可控操作，且不让通用 Agent 能力阻塞 Recorder Demo |
| C6 | **`riskLevel: write/critical` 步骤一律停下等确认** | 无论快慢通道；自愈后的写动作也不能绕过确认 |
| C7 | **定位不生成脆弱 CSS 路径，优先生成语义策略描述** | class 每次 build 变化 |
| C8 | **凭证不落 DSH 存储**，仅存在于浏览器 profile / 页面上下文 | 合规立足点 |
| C9 | **浏览器侧代码零依赖、零 Node API** | 需作为 IIFE 注入 |
| C10 | **所有 LLM 调用写入 `llm-trace.jsonl`，但落盘前必须脱敏** | 可复盘且不能泄漏凭证/隐私 |
| C11 | **所有 Record / HAR / Diagnostic / LLM Trace 落盘前统一经过 sanitizer** | Authorization、Cookie、Set-Cookie、password、token、session 等不得持久化 |
| C12 | **写操作失败不能直接等价为“未执行”**；必须区分 `not_sent / confirmed_success / confirmed_failure / outcome_unknown` | `outcome_unknown` 自动 fallback 会造成重复业务提交 |
| C13 | **认证状态必须是四态：authenticated / unauthenticated / forbidden / unknown**；403 不得直接当掉登录 | 避免权限不足被误判为会话过期 |
| C14 | **Session Recovery 只负责恢复认证，不负责擅自重放业务动作**；是否 retry 由 Replay Engine 结合 `ExecutionOutcome` 决策 | 统一写操作安全语义 |
| C15 | **动作-请求关联必须使用 request 发起时间，不得使用 response 到达时间** | 慢响应会错归属到后续动作 |

---

## 2. 冻结契约（不得擅改）

以下类型是任务之间的接口，先实现，后续任务一律依赖它们。

### 2.1 定位策略（`packages/core/src/types.ts`）

```ts
export type LocatorStrategy =
  | { strategy: 'el-form-item'; label: string; kind: ControlKind }
  | { strategy: 'el-option'; text: string; ownerLabel: string }
  | { strategy: 'el-dialog-scoped'; dialogTitle: string; inner: LocatorStrategy }
  | { strategy: 'el-table-cell'; rowAnchorText: string; buttonText: string }
  | { strategy: 'text'; text: string; exact?: boolean; nth?: number }
  | { strategy: 'role'; role: string; name: string }
  | { strategy: 'css'; selector: string };          // 兜底，录制器尽量不产出

export type ControlKind =
  | 'input' | 'textarea' | 'select' | 'datepicker'
  | 'radio' | 'checkbox' | 'button' | 'text';
```

### 2.2 技能定义（`packages/core/src/schema.ts`，用 zod）

```ts
export const StepSchema = z.object({
  id: z.string(),
  desc: z.string(),
  channel: z.enum(['network', 'ui', 'merged', 'auto']),
  riskLevel: z.enum(['read', 'write', 'critical']).default('read'),
  hasSideEffect: z.boolean().default(false),
  network: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    url: z.string(),
    headers: z.record(z.string()).optional(),
    contentType: z.enum(['json', 'form']).default('json'),
    body: z.record(z.any()).optional(),
    extract: z.record(z.string()).optional(),      // { varName: '$.jsonPath' }
  }).optional(),
  ui: z.object({
    action: z.enum(['navigate','click','fill','selectOption',
                    'setDateTime','waitFor','readValue']),
    url: z.string().optional(),
    target: LocatorStrategySchema.optional(),
    label: z.string().optional(),                   // el-form-item 快捷写法
    kind: ControlKindSchema.optional(),
    value: z.string().optional(),
    waitFor: z.object({
      selector: z.string().optional(),
      notEmpty: z.boolean().optional(),
      timeoutMs: z.number().optional(),
    }).optional(),
    preAction: z.lazy(() => UiActionSchema).optional(),
    extract: z.record(z.string()).optional(),
  }).optional(),
});

export const PreflightSchema = z.object({
  name: z.string(),
  request: z.object({
    method: z.enum(['GET', 'POST']).default('GET'),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }).optional(),                              // 省略 request = 从当前页面 DOM 提取
  extract: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('dom'),
      selector: z.string(),
      attribute: z.string().default('value'),
    }),
    z.object({
      type: z.literal('jsonPath'),
      path: z.string(),
    }),
    z.object({
      type: z.literal('regex'),
      pattern: z.string(),
      group: z.number().default(1),
    }),
  ]),
});

export const SkillSchema = z.object({
  skill: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    system: z.string(),
    baseUrl: z.string(),
    version: z.number().default(1),
    recordedAt: z.string().optional(),
  }),
  auth: z.object({
    probeUrl: z.string(),
    sessionApi: z.string().optional(),
    loggedInJsonPath: z.string().optional(),
    loginUrlPatterns: z.array(z.string()).default([]),
    loginDomMarkers: z.array(z.string()).optional(),
    loginTimeoutMs: z.number().default(300000),
  }).optional(),
  params: z.array(z.object({
    name: z.string(),
    type: z.enum(['string','number','date','datetime','enum','boolean']),
    values: z.array(z.string()).optional(),
    required: z.boolean().default(true),
    format: z.string().optional(),
    prompt: z.string().optional(),
  })),
  preflight: z.array(PreflightSchema).default([]),
  steps: z.array(StepSchema),
  assertions: z.array(z.object({
    type: z.enum(['httpStatus','jsonPath','textPresent','regexExtract']),
    expect: z.any().optional(),
    path: z.string().optional(),
    pattern: z.string().optional(),
    name: z.string().optional(),
  })).default([]),
  _healHistory: z.array(z.object({
    at: z.string(), step: z.string(), reason: z.string(),
    old: z.any(), new: z.any(), verified: z.boolean(), model: z.string(),
  })).optional(),
  _notes: z.array(z.string()).optional(),
});

export type Skill = z.infer<typeof SkillSchema>;
```

**Preflight 统一语义**：
- 当前页 CSRF meta：无 `request` + `extract.type=dom`
- Legacy `__VIEWSTATE`：先 `request: GET` HTML，再用 `extract.type=dom` 解析返回 HTML
- JSON token 接口：先 `request: GET`，再用 `extract.type=jsonPath`

### 2.3 录制会话产物（`record.json`）

```ts
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

export interface RecordedRequest {
  requestId: string;
  requestTs: number;                     // 请求发起时间：动作关联只用这个字段
  responseTs: number | null;             // 响应到达时间；响应丢失时为 null
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;       // 已经过 sanitizer
  postData: string | null;               // 已经过 sanitizer
  status: number | null;                 // 未收到响应时为 null
  responseBody: string | null;           // 已经过 sanitizer
  mutating: boolean;
  networkError?: string;
}
```

**硬约束**：动作-请求关联必须基于 `requestTs`；`responseTs` 仅用于耗时/诊断。任何字段进入 `record.json` 前先调用统一 sanitizer。

### 2.4 执行上下文与结果

```ts
export type AuthState =
  | 'authenticated'
  | 'unauthenticated'
  | 'forbidden'
  | 'unknown';

export type ExecutionOutcome =
  | 'not_sent'                 // 明确未发出，可安全重试/降级
  | 'confirmed_success'        // 已由响应或 postcondition 确认成功
  | 'confirmed_failure'        // 明确失败，且可证明未产生目标副作用
  | 'outcome_unknown';         // 请求可能已到服务端，但客户端无法确认结果

export interface ExecContext {
  params: Record<string, any>;
  vars: Record<string, any>;              // preflight 与 step extract 产出
  stepResults: Record<string, any>;       // { s2: { approverId: 1023 } }
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
  extracted: Record<string, any>;
  diagnosticDir?: string;
}

export interface HealCandidate {
  stepId: string;
  oldTarget: LocatorStrategy;
  newTarget: LocatorStrategy;
  resolveVerified: boolean;               // 仅验证唯一匹配/可见/enabled/语义，不代表已执行写动作
  actionVerified: boolean;                // 真正动作 + postcondition 已通过后才为 true
  requiresConfirm: boolean;
  model: string;
}
```

**统一安全语义**：
- 只有 `not_sent`，或能证明“无目标副作用”的 `confirmed_failure`，才允许自动 retry/fallback。
- `outcome_unknown` 禁止自动切 UI 或重放写请求；必须先跑 postcondition/assertion。仍无法判断时中止并输出诊断包。
- Auth 模块只报告 `AuthState` 与完成登录握手，不直接决定业务动作是否重跑。

### 2.5 LLM Provider

```ts
export interface ILLMProvider {
  name: string;
  supportsVision: boolean;                 // 内网恒为 false
  chat(messages: LLMMessage[], opts?: {
    jsonSchema?: object;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string>;
}

export interface LLMMessage { role: 'system' | 'user' | 'assistant'; content: string }
```

### 2.6 浏览器侧全局对象（注入后可用）

```ts
declare global {
  interface Window {
    __DSH_LOCATOR__: {
      byFormItem(label: string, kind: ControlKind): HTMLElement;
      selectOption(label: string, optionText: string): Promise<void>;
      setDateTime(label: string, value: string): Promise<void>;
      inDialog<T>(title: string, fn: (dlg: HTMLElement) => T): Promise<T>;
      tableRowButton(rowAnchorText: string, buttonText: string): HTMLElement;
      resolve(strategy: LocatorStrategy): Promise<HTMLElement>;
      robustClick(el: HTMLElement): void;
      setInputValue(el: HTMLElement, value: string): void;
      waitFor<T>(fn: () => T, timeout?: number): Promise<T>;
      version(): 'element-plus' | 'element-ui';
    };
    __DSH_SNAPSHOT__: () => string;
    __DSH_GEN__: (el: Element) => LocatorStrategy;
    __DSH_RECORD__?: (action: any) => void;     // 由 exposeBinding 注入
    __DSH_RECORDING__?: boolean;
  }
}
```

---

## 3. 任务清单

格式说明：
- **依赖**：必须先完成的任务 ID
- **交付**：新增/修改的文件
- **验收**：可直接执行的命令，必须通过
- **DoD**：Definition of Done，人工检查项

---

### M0 · 项目骨架

---

#### T-01 · 初始化 monorepo 骨架
**依赖**：无
**交付**：
- `package.json`（pnpm workspace root，scripts: `build` `test` `lint` `e2e`）
- `pnpm-workspace.yaml`
- `tsconfig.base.json`（strict、paths 映射 `@dsh/*`）
- `vitest.config.ts`
- `.eslintrc.cjs`、`.prettierrc`
- `.gitignore`（含 `runs/`、`profiles/`、`.env`）
- `.env.example`（`DSH_LLM_BASE_URL` / `DSH_LLM_API_KEY` / `DSH_LLM_MODEL`）
- `packages/*/package.json` 与空 `src/index.ts`（8 个包）

**实现要点**：
- 所有包 `"type": "module"`
- 包名统一 `@dsh/core`、`@dsh/locator` …

**验收**：
```bash
pnpm install && pnpm build && pnpm test
```
**DoD**：8 个包全部能被 `import`，`pnpm -r exec tsc --noEmit` 无错误

---

#### T-02 · 冻结契约类型、常量与安全基础设施
**依赖**：T-01
**交付**：
- `packages/core/src/types.ts` —— §2.1 / 2.3 / 2.4 / 2.5 / 2.6 全部类型，包含 `AuthState`、`ExecutionOutcome`、`HealCandidate`
- `packages/core/src/constants.ts`

```ts
export const TIMEOUTS = {
  waitForDefault:   5_000,
  selectPanel:      3_000,
  dialogAnimation:    200,
  afterSelect:        120,
  afterDateTime:      100,
  navigation:      30_000,
  loginPoll:        1_500,
  loginTotal:     300_000,
  networkStep:     15_000,
} as const;

export const RETRY = {
  stepMax:        2,
  healMax:        2,
  llmSchemaMax:   3,
  exploreMaxSteps: 20,
} as const;

export const NOISE_PATTERNS: RegExp[] = [
  /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i,
  /\/(heartbeat|ping|track|collect|analytics|log|sockjs|__vite)/i,
];
```

- `packages/core/src/errors.ts` —— 错误类：`LocatorNotFoundError`、`LoginTimeoutError`、`AssertionFailedError`、`LLMValidationError`、`StepExecutionError`、`OutcomeUnknownError`、`ForbiddenError`（每个带 `code` 字段）
- `packages/core/src/sanitize.ts` —— 全链路统一脱敏器：
  - header 名命中 `authorization|cookie|set-cookie|x-api-key|proxy-authorization` → `<REDACTED>`
  - JSON/form 字段名命中 `password|passwd|access_token|refresh_token|token|session|secret|api_key`：**不得保存原值**；改成稳定不可逆指纹，例如 `<REDACTED:sha256:12hex>`
  - 同一原始 secret 在同一录制中必须生成同一 fingerprint，不同 secret 生成不同 fingerprint；这样 T-30 仍能做“响应值 → 后续请求值”依赖识别，但无法反推出原 secret
  - CSRF/ViewState 同样不得持久化真实值；可保留字段名/来源描述及不可逆 fingerprint
  - 支持递归对象、header map、form 字符串与普通文本的 best-effort 脱敏

**验收**：
```bash
pnpm --filter @dsh/core exec tsc --noEmit
pnpm --filter @dsh/core test
```

测试至少覆盖：Authorization/Cookie/Set-Cookie、password、嵌套 token、普通业务字段不被误删；**同一个 token 两次输入产生相同 fingerprint、不同 token 产生不同 fingerprint**。

**DoD**：后续不得擅自新增/修改**跨包冻结契约**；包内实现类型可按任务需要增加。**任何需要落盘的请求/诊断/LLM 内容必须复用 `sanitize.ts`，不得各包自写一套脱敏规则**。
---

#### T-03 · Skill Schema 与模板引擎
**依赖**：T-02
**交付**：
- `packages/core/src/schema.ts` —— §2.2 全部 zod schema + `parseSkill(yamlText): Skill`
- `packages/core/src/template.ts`

模板引擎规格：
```
{{paramName}}              → params.paramName
{{s2.approverId}}          → stepResults.s2.approverId
{{csrf}}                   → vars.csrf
{{type|enumValue}}         → 枚举 label → value 映射
{{startTime|date:YYYY-MM-DD}} → 日期格式化
{{items[i].name}}          → 数组循环占位（由 network 执行器展开）
```
- 未解析到的变量必须**抛错**，不得静默替换为空字符串
- 支持嵌套对象/数组的深度遍历替换

**验收**：
```bash
pnpm --filter @dsh/core test
```
测试用例至少覆盖：普通参数、跨步引用、preflight 变量、enumValue 过滤器、date 过滤器、**变量缺失抛错**、嵌套对象替换

**DoD**：`resolveTemplate({a:{b:'{{x}}'}}, ctx)` 返回深拷贝，不修改原对象

---

### M1 · Mock OA 环境

---

#### T-04 · Mock 后端骨架
**依赖**：T-01
**交付**：`apps/mock-oa/backend/`
- Express + `express-session`（cookie name `MOCK_OA_SID`）
- 中间件 `csrf.js`：生成 token 存 session，校验 `X-CSRF-TOKEN` 头
- 中间件 `delay.js`：所有 `/api/*` 随机延迟 300–800ms（K10），可用 `?_nodelay=1` 关闭
- 路由：
  - `POST /api/login` `{username,password}` → 任意非空即成功，种 session
  - `GET  /api/session` → `{ loggedIn: boolean, user?: string }`
  - `GET  /api/csrf` → `{ token }`
  - `POST /api/_debug/expire` → 销毁 session（K12）
  - `GET /api/_debug/forbidden` → 登录后固定返回 403（仅测试 AuthState，不销毁 session）
  - 未登录访问 `/api/*`（除 login/session/csrf）→ 401

**验收**：
```bash
pnpm --filter mock-oa-backend dev &
curl -s localhost:3000/api/session            # {"loggedIn":false}
curl -si localhost:3000/api/overtime/types | head -1   # HTTP/1.1 401
```

---

#### T-05 · Mock 业务接口 + 依赖陷阱 + 响应丢失安全场景
**依赖**：T-04
**交付**：
- `GET  /api/overtime/types` → `[{value:'workday',label:'工作日加班'},{value:'weekend',label:'周末加班'},{value:'holiday',label:'节假日加班'}]`
- `POST /api/overtime/approver` `{type}` → `{approverId, approverName, approvalToken}`
  - `approverId` 按 type 映射到不同审批人
  - `approvalToken` **每次调用动态生成**，绑定当前 session + type + approverId，短期有效且提交后消费
- `POST /api/overtime/submit` → 校验 csrf + `approverId` 与 type 匹配 + **approvalToken 必须是本次流程由 approver 接口生成的有效动态值**，返回 `{code:0, no:'OT-YYYYMMDD-NNNN'}`
- `GET  /api/leave/types`、`POST /api/leave/balance`、`POST /api/leave/submit`（同构）
- `GET  /api/overtime/history?page=&size=` → 200 条假数据（供 K9 虚拟滚动）
- `GET  /api/_debug/submissions` → 返回当前 session 已创建的申请列表/数量，仅测试使用
- `POST /api/overtime/submit?drop_response=1` → **先真实创建一条申请并消费 approvalToken，再主动断开 socket，不返回完整 HTTP 响应**，用于验证 `outcome_unknown` 不会触发二次提交

**实现要点**：
- `approvalToken` 是**故意设计的依赖陷阱**：若分析器只把录制时的 approverId/token 硬编码进 YAML，或跳过 approver 步骤直接 submit，后续 replay 必然失败。
- 依赖验证不能只用“同样的 workday 再放一次”；至少有一条测试要把录制时的 `type=workday` 改成 `type=weekend`，证明 replay 会重新调用 approver 并注入新 `approverId + approvalToken`。
- `drop_response=1` 场景故意模拟“服务端已 commit、客户端不知道结果”。

**验收**：
```bash
# 1) 错误 approverId 必须失败
curl -X POST .../api/overtime/submit -d '{"type":"workday","approverId":9999,...}'
# → {"code":400,"msg":"审批人不匹配"}

# 2) 缺失/复用旧 approvalToken 必须失败
# 3) 调 approver 获得新 token 后 submit 必须成功
```

**DoD**：能够稳定构造两类反例：
1. **跳过 approver → submit 必失败**；
2. **submit 已 commit 但响应丢失 → `/api/_debug/submissions` 明确显示仅已创建 1 条**。
---

#### T-06 · Mock Vue3 前端骨架
**依赖**：T-04
**交付**：`apps/mock-oa/frontend/`
- Vue 3 + Element Plus + Vite + vue-router
- 页面：`Login.vue` `Home.vue` `LeaveApply.vue` `OvertimeApply.vue` `History.vue`
- `index.html` 中注入 `<meta name="csrf-token" content="...">`（登录后由前端写入）
- axios 封装：自动带 `X-CSRF-TOKEN`；401 时跳登录页；**403 只显示“无权限”，不得跳登录页**

**验收**：`pnpm --filter mock-oa-frontend dev` 后手动登录可进首页

---

#### T-07 · 复刻坑点 K1–K6、K10
**依赖**：T-05, T-06
**交付**：`OvertimeApply.vue` 严格按 v3.1 §2.4 实现
- K1：`el-select` 保持默认 `append-to-body`
- K2：`el-date-picker` `type="datetime"` `:editable="false"`
- K3：提交前弹 `el-dialog`，保留默认动画
- K5：提交按钮用 `<style module>` 的 class + `role="button"` + `@click`
- K6：`@change="loadApprover"` 调联动接口；`approverName` 只读展示，`approverId + approvalToken` 保存在页面内存并随最终 submit 发送（approvalToken 不展示给用户）
- K10：`loadApprover` 内 `await sleep(500)`

`LeaveApply.vue` 同构（联动接口换成 `balance`）

**验收**：
```bash
pnpm --filter e2e test -g "K-points"
```
测试断言：
- `document.querySelector('.el-select .el-select-dropdown__item')` 为 null（面板在 body）
- 提交按钮的 className 匹配 `/_submitBtn_\w+/`
- 选择类型后 600ms 内 `/api/overtime/approver` 被调用
- 最终 submit body 中含本次 approver 响应产生的 `approverId + approvalToken`，切换 type 后旧 token 失效

---

#### T-08 · Vite 哈希每次 build 变化
**依赖**：T-06
**交付**：`apps/mock-oa/frontend/vite.config.ts`
```ts
css: { modules: {
  generateScopedName: `[local]_${Math.random().toString(36).slice(2,8)}_[hash:base64:5]`
}}
```
外加 `scripts/verify-hash-changes.mjs`：连续 build 两次，比对产物中 `submitBtn` 的 class 名必须不同

**验收**：
```bash
node apps/mock-oa/scripts/verify-hash-changes.mjs   # exit 0 表示两次 hash 不同
```

---

#### T-09 · Legacy SSR 页面 + Vue2 页面
**依赖**：T-05
**交付**：
- `backend/routes/legacy.js`：
  - `GET /legacy/overtime` → 服务端渲染 HTML，含 `<input type="hidden" name="__VIEWSTATE" value="...">` 和 `__TOKEN`
  - `POST /legacy/overtime/submit` → `application/x-www-form-urlencoded`，校验两个隐藏字段，返回 HTML 含"提交成功"
- `apps/mock-oa/frontend-vue2/`：Vue 2.7 + Element UI 2.15，只做一个加班申请页，接口复用

**验收**：
```bash
pnpm --filter e2e test -g "legacy"
pnpm --filter e2e test -g "vue2"
```

---

#### T-10 · 反向验证：朴素选择器必须失败
**依赖**：T-07, T-08
**交付**：`e2e/naive-selector.spec.ts`

```ts
test('朴素 CSS 选择器必须失败（否则 mock 不合格）', async ({ page }) => {
  await login(page);
  await page.goto('/overtime/apply');

  // 1. select 面板不在 select 内部
  await expect(
    page.locator('.el-select .el-select-dropdown__item')
  ).toHaveCount(0);

  // 2. 哈希 class 在重新 build 后失效
  const cls = await page.locator('[role=button]:has-text("提交")')
                        .getAttribute('class');
  expect(cls).toMatch(/_submitBtn_\w+/);
  // 记录当前 hash，供 T-53 build 后对比
});
```

**验收**：`pnpm --filter e2e test -g "朴素"`
**DoD**：⚠️ **此测试通过 = mock 环境合格**。若朴素选择器居然能成功，说明坑点没复刻到位，必须回头修 T-07

---

### M2 · 定位器

---

#### T-11 · 浏览器侧构建管线
**依赖**：T-02
**交付**：
- `packages/locator/build.mjs` —— esbuild 打包为 IIFE，输出 `dist/el-locator.iife.js`、`dist/recorder-probe.iife.js`、`dist/snapshot.iife.js`
- `packages/locator/src/_guard.ts` —— 构建时校验：产物中不得出现 `require(`、`process.`、`import `

**验收**：
```bash
pnpm --filter @dsh/locator build
node -e "const s=require('fs').readFileSync('packages/locator/dist/el-locator.iife.js','utf8'); if(/require\(|process\./.test(s)) process.exit(1)"
```

---

#### T-12 · el-locator 核心
**依赖**：T-11
**交付**：`packages/locator/src/el-locator.ts`

实现 §2.6 中 `__DSH_LOCATOR__` 的全部方法，严格按 v3.1 §3.3 代码：
- `version()`：探测 `.el-form-item` 上是否存在 Element Plus 特有类，返回 `'element-plus' | 'element-ui'`
- `byFormItem(label, kind)`：label 归一化去掉 `:：*` 和空白
- `selectOption(label, text)`：**必须处理 append-to-body**，取最后一个可见 `.el-select-dropdown`
- `setDateTime(label, value)`：原生 setter + input/change + Enter + `document.body.click()`
- `inDialog(title, fn)`：等 `opacity === 1` 再等 `TIMEOUTS.dialogAnimation`
- `tableRowButton(anchorText, buttonText)`
- `robustClick(el)`：pointerdown/mousedown/pointerup/mouseup/click 全序列派发
- `setInputValue(el, value)`：原生 setter + input/change
- `resolve(strategy)`：`LocatorStrategy` 联合类型的分发器
- `waitFor(fn, timeout)`

**验收**：`pnpm --filter e2e test -g "el-locator"`
测试覆盖：每个方法在 Vue3 mock 页上单独调通

---

#### T-13 · Element UI 2.x 兼容层
**依赖**：T-12, T-09
**交付**：`packages/locator/src/compat.ts`
- 类名映射表（两版差异处）
- `el-dialog` 结构差异处理
- `version()` 探测后自动切换策略

**验收**：`pnpm --filter e2e test -g "el-locator vue2"` —— 同一套 API 在 Vue2 页面上全部通过

---

#### T-14 · 手写脚本跑通加班流程（不含录制器）
**依赖**：T-12
**交付**：`e2e/manual-overtime.spec.ts`
用 `page.evaluate` 直接调 `__DSH_LOCATOR__` 完成：登录 → 进加班页 → 选类型 → 填时间 → 填事由 → 提交 → 确认弹窗 → 断言成功

**验收**：
```bash
pnpm --filter e2e test -g "manual-overtime" --repeat-each=20
```
**DoD**：20 次连续通过。**这是 M2 的出口标准**，不达标不进入 M3

---

#### T-15 · 选择器生成器
**依赖**：T-12
**交付**：`packages/locator/src/selector-generator.ts` → `window.__DSH_GEN__(el): LocatorStrategy`

优先级（从高到低）：
1. `el-select-dropdown__item` → `el-option`
2. 在 `.el-dialog` 内 → `el-dialog-scoped`（递归生成 inner）
3. 在 `.el-table__row` 内 → `el-table-cell`（`pickRowAnchor` 取该行最长的非空文本单元格）
4. 在 `.el-form-item` 内 → `el-form-item`
5. 有 `role` + 可见文本 → `role`
6. 有稳定文本 → `text`
7. 兜底 → `css`（**必须打日志警告**）

**禁止**：生成含哈希 class（匹配 `/_\w+_\w{5,}/` 或 `/^data-v-/`）的 css 选择器

**验收**：`pnpm --filter e2e test -g "selector-generator"`
测试断言：对 mock 页 12 个典型元素生成的策略，**没有一个是 `css`**

---

#### T-16 · 压缩快照生成器
**依赖**：T-12
**交付**：`packages/locator/src/snapshot.ts` → `window.__DSH_SNAPSHOT__(): string`

输出格式：
```
[页面] 加班申请
[1] select   "加班类型"   值:(空)  可选: 工作日加班/周末加班/节假日加班
[2] input    "开始时间"   值:(空)  类型: datetime
[3] textarea "事由"       值:(空)
[4] text     "审批人"     值: —
[5] button   "提交"
```
规则：
- 弹窗打开时**只输出弹窗内元素**，首行 `[对话框: 确认提交]`
- 表格：表头 + 前 5 行 + `… 共 N 行`
- 剔除不可见元素（`offsetParent === null` 或 `visibility:hidden`）
- 剔除纯布局 div
- 单个文本截断 60 字符
- **总长度上限 8000 字符**，超出时优先保留可交互元素

**验收**：`pnpm --filter e2e test -g "snapshot"`
断言：加班页快照 < 2000 token（用 `Math.ceil(len/2.5)` 粗估中文 token），且包含全部 6 个可交互元素

---

### M3 · 浏览器载体与认证

---

#### T-17 · Playwright 持久化上下文封装
**依赖**：T-02, T-11
**交付**：`packages/browser/src/context.ts`

```ts
export interface BrowserOptions {
  profileDir: string;
  channel?: 'chrome' | 'msedge';
  executablePath?: string;
  headless?: boolean;
  proxy?: { server: string; bypass?: string };
  authServerAllowlist?: string;          // Kerberos/NTLM
  clientCertificates?: Array<{ origin: string; pfxPath: string; passphrase?: string }>;
  timeoutMs?: number;
}

export async function launchDSHContext(opts: BrowserOptions): Promise<BrowserContext>;
```

要点：
- 默认 `channel: 'chrome'`、`headless: false`
- `authServerAllowlist` 存在时追加 `--auth-server-allowlist=` 与 `--auth-negotiate-delegate-allowlist=`
- **必须 `addInitScript` 注入三个 IIFE 产物**（el-locator / snapshot / selector-generator）

**验收**：`pnpm --filter @dsh/browser test`
断言：新页面上 `window.__DSH_LOCATOR__` 与 `window.__DSH_SNAPSHOT__` 存在

---

#### T-18 · 登录状态探测（四态，不再返回 boolean）
**依赖**：T-17
**交付**：`packages/browser/src/auth.ts` → `getAuthState(page, auth): Promise<AuthState>`

判定优先级：
1. 配了 `sessionApi` → 页面内 `fetch`：
   - 401 → `unauthenticated`
   - 403 → `forbidden`（**禁止当成掉登录**）
   - 2xx 且配置 `loggedInJsonPath` → 按该路径布尔值判断 `authenticated/unauthenticated`
   - 2xx 但返回内容疑似登录 HTML（命中 `loginDomMarkers`）→ `unauthenticated`
   - 无法可靠判断 → `unknown`
2. 无 `sessionApi` → 当前 URL 命中任一 `loginUrlPatterns` 为 `unauthenticated`
3. URL 不命中且 DOM 命中 `loginDomMarkers` → `unauthenticated`
4. 其他无法证明已登录的情况 → `unknown`，**不得乐观当 authenticated**

**验收**：`pnpm --filter e2e test -g "auth-state"`

覆盖至少四态：已登录 / 未登录 / 已登录但无权限 403 / sessionApi 返回 200 登录 HTML。

**DoD**：任何调用方不得出现 `401 || 403 => 未登录` 的合并判断。
---

#### T-19 · 登录握手
**依赖**：T-18
**交付**：`packages/browser/src/auth.ts` → `ensureLoggedIn(page, auth): Promise<void>`

- `getAuthState() === authenticated` → 直接返回
- `forbidden` → 立即抛 `ForbiddenError`，**不弹登录横幅、不轮询**
- `unauthenticated` → `page.bringToFront()` → 注入蓝色横幅 `#__dsh_login_hint__`
- `unknown` → 允许做一次 `probeUrl` 刷新/重新探测；仍 unknown 则报错，不无限等待用户
- 未登录时每 `TIMEOUTS.loginPoll` 轮询一次
- 成功 → 移除横幅并返回
- 超时 → 抛 `LoginTimeoutError`

**验收**：`pnpm --filter e2e test -g "ensureLoggedIn"`

测试脚本：调 `/api/_debug/expire` 使会话失效 → 调 `ensureLoggedIn` → 模拟用户登录 → 正常返回；另测 403 时函数立即失败且不出现登录横幅。
---

#### T-20 · 会话过期中途恢复信号（只恢复认证，不重放业务动作）
**依赖**：T-19
**交付**：`packages/browser/src/auth.ts`

```ts
export async function recoverAuthentication(page: Page, auth: AuthConfig): Promise<void>;
export function classifyAuthFromResponse(status: number, url: string, auth: AuthConfig): AuthState | null;
```

规则：
- 401 或明确跳转登录页 → 可判定 `unauthenticated`，调用 `ensureLoggedIn`
- 403 → `forbidden`，禁止触发重新登录循环
- 本任务**不得接收 `fn` 并自动重跑 fn**；Auth 层只负责“识别 + 恢复认证”
- 业务步骤是否重试由 M6 Replay Engine 根据 `ExecutionOutcome` 决策（C12/C14）

**验收**：`pnpm --filter e2e test -g "session-recovery"`
- safe GET 在会话过期后可：检测 → 登录握手 → 由测试显式重试 GET → 成功
- 403 不进入握手
- 测试中确认 `recoverAuthentication` 本身没有执行任何业务 POST

**DoD**：代码库中不存在通用 `withSessionRecovery(..., fn) => 自动重跑 fn` 这种会把写操作重复执行的封装。
---

#### T-21 · CDP 会话封装（备用能力）
**依赖**：T-17
**交付**：`packages/browser/src/cdp.ts` —— `attachCDP(page)`，暴露 `Network.enable`、`Fetch.enable` 的薄封装
**验收**：单测能拿到一条请求的 response body

---

#### T-22 · `dsh doctor` 载体自检
**依赖**：T-17
**交付**：`packages/cli/src/doctor.ts`

输出 v3.1 §7.5 清单的检查结果：
```
✓ Chrome 已安装        版本 138.0.7204.93
✓ 可启动 persistent context
✓ IIFE 注入成功
? 认证类型            需人工确认（A: Kerberos / B: 表单 / C: 证书）
✓ 代理配置            未设置
✗ remote-debugging    被企业策略禁用   ← 如出现此项需上报
```

**验收**：`pnpm dsh doctor` 输出完整清单
**DoD**：此命令是内网现场第一个要跑的东西，输出必须可直接贴给运维

---

### M4 · 录制器

---

#### T-23 · 录制探针
**依赖**：T-15
**交付**：`packages/locator/src/recorder-probe.ts`

按 v3.1 §4.2：
- 仅当 `window.__DSH_RECORDING__ === true` 时工作
- `click` 捕获阶段监听：`.el-select` 内点击 → 记 `openSelectLabel` 并 return；`.el-select-dropdown__item` → emit `select`；其他 → emit `click`
- `change` 捕获阶段：date-editor → `datetime`；其他 → `fill`
- 通过 `window.__DSH_RECORD__` 上报（Playwright `exposeBinding`）

**注意**：必须处理 select 面板在 body 上的情况——`openSelectLabel` 需要跨元素保持状态

**验收**：`pnpm --filter e2e test -g "recorder-probe"`
断言：手动完成加班流程后，收到的 action 序列为 `[navigate, select, datetime, datetime, fill, click, click]`

---

#### T-24 · 网络录制（request/response 双时间戳 + 落盘前脱敏）
**依赖**：T-17, T-02
**交付**：`packages/recorder/src/network.ts`

- 在 `page.on('request')` 时创建记录并写 `requestTs`、`requestId`、method/url/resourceType/postData
- 在 `page.on('response')` 时按 requestId 补 `responseTs`、status、responseBody
- 在 `requestfailed` 时补 `networkError`，`responseTs/status` 可保持 null
- 用 `NOISE_PATTERNS` 过滤
- 非 xhr/fetch 的 GET 一律丢弃
- `responseBody` 用 `res.text().catch(() => null)`
- 标记 `mutating = method !== 'GET'`
- **headers/postData/responseBody 在进入 RecordSession 前统一调用 `sanitize.ts`**；动态 token 用稳定不可逆 fingerprint 替代，使 response/request 中同一 secret 仍可做依赖相关性分析

**验收**：`pnpm --filter e2e test -g "network-record"`

断言：
- 加班流程保留请求数 ≤ 5，必含 `approver` 与 `submit`
- 每条正常请求有 `requestTs <= responseTs`
- 人为慢响应不会改变 `requestTs`
- Authorization/Cookie/password/token 不出现在序列化后的 `record.json`

**DoD**：后续 analyzer 只允许使用 `requestTs` 做动作关联；禁止用 response 到达时间代替。
---

#### T-25 · 录制会话编排
**依赖**：T-23, T-24
**交付**：`packages/recorder/src/session.ts`

```ts
export async function record(opts: {
  url: string; profileDir: string; outDir: string; auth?: AuthConfig;
}): Promise<RecordSession>;
```

流程：启动 context → `ensureLoggedIn` → `exposeBinding('__DSH_RECORD__')` → 置 `__DSH_RECORDING__=true` → 页面注入红色录制条 → 等待用户操作 → 用户在终端按 Enter 或关闭浏览器结束 → 写 `record.json`

**验收**：`pnpm dsh record --url http://localhost:5173/overtime/apply --out ./tmp/rec1`
**DoD**：产出的 `record.json` 通过 `RecordSession` 类型校验

---

#### T-26 · `dsh record` CLI
**依赖**：T-25
**交付**：`packages/cli/src/record.ts`
参数：`--url` `--out` `--profile` `--channel` `--auth <file>`
**验收**：`pnpm dsh record --help` 输出完整；实际录制产出文件

---

#### T-27 · `dsh diff` 双录对比
**依赖**：T-25
**交付**：`packages/cli/src/diff.ts`

对比两份 `record.json`：
- 动作序列结构是否一致（不一致直接告警）
- 逐位置对比 value，**不同的标记为参数候选**
- 网络请求 body 逐字段对比，不同的标记为参数候选

输出：
```
参数候选（两次录制值不同）：
  action[1].value    "工作日加班" ≠ "周末加班"     → 建议参数: type
  action[2].value    "2026-08-18 18:00" ≠ ...      → 建议参数: startTime
  网络 s5.body.reason "版本上线" ≠ "紧急修复"      → 建议参数: reason

固定值（两次相同，不建议参数化）：
  网络 s5.headers.X-CSRF-TOKEN  → 来自 preflight
```

**验收**：`pnpm dsh diff ./tmp/rec1 ./tmp/rec2`

---

#### T-28 · 录制器端到端验证
**依赖**：T-26
**交付**：`e2e/record.spec.ts` —— 脚本化模拟用户操作，验证录制产物完整
**验收**：`pnpm --filter e2e test -g "record e2e"`

---

### M5 · 分析器

---

#### T-29 · 动作-请求关联（以 request 发起时间为准）
**依赖**：T-25
**交付**：`packages/analyzer/src/correlate.ts`

```ts
export function correlate(session: RecordSession): CorrelatedStep[];
```

规则：
- **只使用 `RecordedRequest.requestTs`**，禁止使用 `responseTs`
- 请求归给“最近的前置 action”，窗口边界为：
  `action[i].ts <= requestTs < min(action[i+1].ts, action[i].ts + 2000ms)`
- 一个 action 可关联多个请求
- 不允许同一请求同时归属两个 action
- 无归属请求单独列为 `orphan`（页面加载初始化请求）

**验收**：`pnpm --filter @dsh/analyzer test`

必须有慢响应反例：
- action A 发请求 A；500ms 后发生 action B；请求 A 在 800ms 才返回
- 断言请求 A 仍归属 action A，而不是因为 response 晚到错归 B
- 加班录制中 `approver` 请求归属到 `select` 动作。
---

#### T-30 · 副作用与依赖识别
**依赖**：T-29
**交付**：`packages/analyzer/src/correlate.ts`（续）

- `hasSideEffect`：该 action 关联了 `mutating` 请求
- **依赖识别**：遍历请求 B 的 body 所有叶子值，若某值出现在请求 A 的 responseBody 中（JSON 深度搜索），记 `B.dependsOn.push({ from: A.id, path, to })`；敏感动态值使用 sanitizer 生成的**稳定 fingerprint**进行等值关联，不需要也不得恢复原 secret
- 加班场景必须同时识别：
  - `submit.body.approverId <- approver.$.approverId`
  - `submit.body.approvalToken <- approver.$.approvalToken`
- 终态识别：最后一个 mutating 请求标记 `isSubmit`

**验收**：
1. 单测断言 `submit.dependsOn` 同时包含 `approverId` 与 `approvalToken`；
2. **端到端反例**：录制 workday，生成 draft 后 replay 时把参数改为 weekend；若 replay 未重新执行 approver 并注入新值，Mock submit 必须拒绝；正确实现必须成功。

**DoD**：⚠️ 这是整个分析器最关键的一条。不能仅靠“原参数原样 replay 成功”证明依赖识别正确。
---

#### T-31 · 参数候选标注
**依赖**：T-29
**交付**：`packages/analyzer/src/params.ts`

启发式（不用 LLM）：
- 用户 `fill`/`select`/`datetime` 输入过的值 → 高置信度参数
- 日期格式值（`/^\d{4}-\d{2}-\d{2}/`）→ 参数，type=datetime
- select 的值 → type=enum，values 从页面可选项收集
- **排除**：token/viewstate/csrf/session/timestamp 类字段名（正则黑名单）
- 若提供了第二份录制，用 diff 结果提升置信度

**验收**：单测断言从加班录制中识别出 4 个参数，且不含 csrf

---

#### T-32 · preflight 与 auth 检测
**依赖**：T-29
**交付**：`packages/analyzer/src/preflight.ts`

- 扫描请求 headers，发现 `X-CSRF-TOKEN`/`X-XSRF-TOKEN`/`__RequestVerificationToken` → 生成 `PreflightSchema`
  - 页面 meta 场景：无 request + `extract:{type:'dom', selector:'meta[name=csrf-token]', attribute:'content'}`
- 扫描 form body，发现 `__VIEWSTATE`/`__EVENTVALIDATION` → 生成：
  - `request:{method:'GET', url:'当前表单页'}`
  - `extract:{type:'dom', selector:'input[name="__VIEWSTATE"]', attribute:'value'}`
- JSON token 接口 → `request GET` + `extract.type='jsonPath'`
- 扫描 401、明确登录跳转与登录页 DOM marker，推断 `auth.loginUrlPatterns`；**403 只标注可能 forbidden，不得写成 login pattern**
- 发现类似 `/api/session`、`/api/user/current` 的请求 → 建议为 `auth.sessionApi`

**验收**：单测覆盖：
- Vue3 meta csrf
- Legacy `__VIEWSTATE` HTML
- JSON token
- 401 登录过期
- 403 权限不足不被误判为登录过期。
---

#### T-33 · draft.yaml 生成器
**依赖**：T-30, T-31, T-32
**交付**：`packages/analyzer/src/draft.ts`

- 输出严格符合 `SkillSchema`
- **channel 判定**：
  - 有关联 mutating 请求 → `network`（同时填 `ui` 作为降级）
  - 无关联请求的 fill/datetime → `merged`
  - 只有导航 → `network`（GET）
- 所有推断项加 `# TODO` 注释（用 `yaml` 库的 comment API，不要字符串拼接）
- 依赖值必须生成跨步模板引用，例如 `approverId: '{{s2.approverId}}'`、`approvalToken: '{{s2.approvalToken}}'`，**不得把录制时动态值硬编码进 YAML**
- `_notes` 写清判断依据
- `riskLevel`：POST/PUT/DELETE → `write`；url 含 approve/delete/pay → `critical`

**验收**：
```bash
pnpm dsh analyze ./tmp/rec1 --out ./skills/oa_overtime_submit.draft.yaml
```
产物必须通过 `parseSkill()` 校验，且 `# TODO` 数量 ≥ 3

---

#### T-34 · `dsh analyze` CLI
**依赖**：T-33
**交付**：`packages/cli/src/analyze.ts`，支持 `--compare <rec2>` 启用 diff 增强
**验收**：`pnpm dsh analyze --help`

---

### M6 · 回放器

---

#### T-35 · 回放引擎骨架
**依赖**：T-03, T-17
**交付**：`packages/replayer/src/engine.ts`

```ts
export async function replay(skill: Skill, opts: {
  params: Record<string, any>;
  profileDir: string;
  dryRun?: boolean;
  forceChannel?: 'ui' | 'network';
  noLLM?: boolean;
  onConfirm?: (step: Step, ctx: ExecContext) => Promise<boolean>;
}): Promise<RunResult>;
```

流程：`launchDSHContext` → `ensureLoggedIn` → 执行 preflight → 逐步执行 → 断言 → 返回 `RunResult`

**验收**：`--dry-run` 模式下能打印完整执行计划而不实际操作

---

#### T-36 · preflight 执行器
**依赖**：T-35
**交付**：`packages/replayer/src/preflight.ts`

严格按冻结的 `PreflightSchema` 执行：

1. **无 request + dom**：从当前页面 DOM 提取
   - 例：`meta[name=csrf-token]` 的 `content`
2. **有 request + jsonPath**：页面上下文内 GET/POST → 解析 JSON → JSONPath 提取
3. **有 request + dom**：页面上下文内 GET/POST → 得到 HTML 文本 → `DOMParser` 解析 → selector + attribute 提取
   - 例：ASP.NET `__VIEWSTATE` / `__EVENTVALIDATION`
4. **有 request + regex**：对响应文本执行 regex 提取

结果写入 `ctx.vars`。所有请求仍遵守 C2；提取到的 token/ViewState 只存在运行时内存，不进入诊断/日志真实值。

**验收**：单测 + e2e：
- `ctx.vars.csrf` 非空
- Legacy 页能成功提取 `__VIEWSTATE`
- JSON token 场景可提取
- 生成诊断信息时看不到上述真实值。
---

#### T-37 · network 通道执行器 + ExecutionOutcome 分类
**依赖**：T-35
**交付**：`packages/replayer/src/channel-network.ts`

**必须严格按 C2**：在 `page.evaluate` 内用 `fetch` + `credentials:'include'`。

- 模板解析后再传入 evaluate
- `contentType: 'form'` → `URLSearchParams`
- 支持 `{{items[i].xxx}}` 数组展开
- `extract` 用 JSONPath 从响应提取，写入 `ctx.stepResults[stepId]`
- 超时 `TIMEOUTS.networkStep`
- 返回 `StepResult.outcome`，至少遵守：
  - 请求在发出前模板/校验失败 → `not_sent`
  - 收到成功响应且断言/业务结果可确认 → `confirmed_success`
  - 收到明确失败响应，且可证明目标副作用未发生 → `confirmed_failure`
  - `fetch` 在请求可能已经发出后超时/连接断开/response 丢失 → `outcome_unknown`
- **绝不能把所有 catch 都映射成 `confirmed_failure`**

**验收**：`pnpm --filter e2e test -g "channel-network"`
- 正常 network 通道完成加班提交，`approverId + approvalToken` 来自 s2
- 模板缺失 → `not_sent`
- `drop_response=1` → 返回 `outcome_unknown`，且服务端 submissions 已增加 1。
---

#### T-38 · ui 通道执行器
**依赖**：T-35, T-12
**交付**：`packages/replayer/src/channel-ui.ts`

- action 分发到 `__DSH_LOCATOR__` 对应方法
- `label` + `kind` 快捷写法转 `el-form-item` 策略
- `preAction` 先执行
- `waitFor` 条件等待
- 失败抛 `LocatorNotFoundError`（带 stepId 与策略详情）

**验收**：`pnpm --filter e2e test -g "channel-ui"`
断言：`--force-channel ui` 能完成加班提交

---

#### T-39 · merged 通道 + 安全降级链（禁止 outcome_unknown 重放）
**依赖**：T-37, T-38, T-20
**交付**：`packages/replayer/src/engine.ts`（续）

- `merged`：只把值写入 `ctx.vars`，不执行
- `auto` / `network + ui fallback`：**只有满足安全重试条件才允许降级**：
  1. `outcome === not_sent`；或
  2. `outcome === confirmed_failure` 且可证明目标副作用未发生
- `outcome_unknown`：
  1. 禁止自动 UI fallback / network retry
  2. 先运行可用 postcondition/assertion 判断业务是否其实成功
  3. 若能确认成功 → 转 `confirmed_success`
  4. 仍无法确认 → 抛 `OutcomeUnknownError` + 诊断包 + 中止，等待人工判断
- 会话失效：先调用 `recoverAuthentication` 恢复认证；**是否重放当前步骤仍按上述 `ExecutionOutcome` 规则**
- `write`/`critical` 步骤执行前调 `onConfirm`；认证恢复、自愈后也不能复用旧确认绕过新的高风险动作语义

**验收**：`pnpm --filter e2e test -g "fallback"`

至少三条：
1. 故意把 s5 URL 改成一个在发送前即可确认无副作用的错误 → 允许降级 UI 并成功；
2. `drop_response=1` → **禁止 UI fallback**，`/api/_debug/submissions` 最终只有 1 条，不得出现重复单；
3. 403 → 报 forbidden，不触发登录循环、不触发业务重试。

**DoD**：这是 M6 的安全硬门槛；“请求异常 = 自动再点一次”视为失败实现。
---

#### T-40 · 断言引擎
**依赖**：T-35
**交付**：`packages/replayer/src/assert.ts`
支持 `httpStatus` / `jsonPath` / `textPresent` / `regexExtract`，失败抛 `AssertionFailedError`
**验收**：单测覆盖 4 种类型的成功与失败路径

---

#### T-41 · 诊断包（全量可复盘，但落盘必须脱敏）
**依赖**：T-35, T-02
**交付**：`packages/replayer/src/diagnostic.ts`

任何失败时在 `runs/<ISO时间戳>/` 产出：
`result.json` / `step-<id>-before.png` / `step-<id>-after.png` / `step-<id>-dom.html` / `step-<id>-snapshot.txt` / `network.har` / `console.log` / `llm-trace.jsonl`（若有）

硬要求：
- `result.json`、HAR、DOM、console、LLM trace 的文本内容写盘前统一经过 `sanitize.ts`
- HAR 中 Authorization/Cookie/Set-Cookie 不能出现真实值
- password/token/session/secret 等字段不能出现在明文文件中
- 截图无法可靠结构化脱敏时，Mock 验收页面不得放真实敏感数据；生产阶段对截图另做策略，不得声称已自动完成像素级脱敏

**验收**：
- 故意破坏一步，断言 8 类文件齐全
- 向 mock 请求注入测试 Authorization/Cookie/password/token，递归 grep `runs/` 不得找到原始秘密值。
---

#### T-42 · `dsh replay` CLI
**依赖**：T-39, T-40, T-41
**交付**：`packages/cli/src/replay.ts`
参数：`--params <json|file>` `--dry-run` `--channel ui|network` `--no-llm` `--profile` `--yes`（跳过确认，仅测试用）
**验收**：
```bash
pnpm dsh replay skills/oa_overtime_submit.yaml \
  --params '{"type":"工作日加班","startTime":"2026-08-18 18:00","endTime":"2026-08-18 21:00","reason":"版本上线"}' \
  --yes
```
**DoD**：**这是 M6 出口**，A1–A5 必须通过

---

### M7 · LLM 主脑

---

#### T-43 · LLM Provider
**依赖**：T-02
**交付**：`packages/llm/src/provider.ts`

- `DeepSeekProvider implements ILLMProvider`，走 OpenAI 兼容端点
- 配置来自环境变量（`.env`）
- `supportsVision` 恒为 `false`（**C3：任何代码不得依赖其为 true**）
- 内置重试（网络错误 3 次指数退避）
- 每次调用写 `llm-trace.jsonl`：`{ts, purpose, model, messages, response, tokensEstimate, durationMs}`；**messages/response 落盘前必须经过 `sanitize.ts`**

**验收**：`pnpm --filter @dsh/llm test`（用 mock server，不打真实 API）

---

#### T-44 · JSON 输出护栏
**依赖**：T-43
**交付**：`packages/llm/src/guard.ts`

```ts
export async function chatJSON<T>(
  llm: ILLMProvider, messages: LLMMessage[],
  schema: z.ZodType<T>, maxRetry = RETRY.llmSchemaMax
): Promise<T>;
```
- 剥离 ```json 围栏
- zod 校验，失败则把错误信息回灌重试
- 超出重试次数抛 `LLMValidationError`

**验收**：单测覆盖：一次成功 / 首次非法二次成功 / 三次全非法抛错

---

#### T-45 · J1 意图路由与参数抽取
**依赖**：T-44
**交付**：`packages/llm/src/route.ts`

```ts
export async function route(llm, userInput: string, skills: Skill[]):
  Promise<{ skillId: string | null; params: Record<string, any>; missing: string[] }>;
```
- 输入：用户自然语言 + 所有技能的 `{id, name, description, params}`
- 输出必须过参数 Schema 校验
- **enum 参数的值必须在 `values` 内，否则算 missing**
- **不允许 LLM 编造未提及的参数值**（prompt 中明确要求，且校验必填项来源）

**验收**：单测（mock LLM）覆盖：命中技能 / 无匹配 / 参数缺失 / enum 非法值

---

#### T-46 · J2 录制后标注
**依赖**：T-44, T-33
**交付**：`packages/llm/src/annotate.ts`

离线增强 draft：技能 id/name/description、每步 desc、参数命名与 prompt、断言建议、风险提示
**所有 LLM 产出必须打 `# TODO`**

**验收**：`pnpm dsh analyze ./tmp/rec1 --llm --out ...`，产物仍通过 `parseSkill()`

---

#### T-47 · J3 失败自愈：先 resolve-only，禁止“为验证而写业务”
**依赖**：T-44, T-38, T-16
**交付**：`packages/llm/src/heal.ts`

```ts
export async function proposeHeal(ctx: {
  llm, page, step: Step, error: Error, snapshot: string
}): Promise<HealCandidate | null>;
```

流程：
1. 抓 `__DSH_SNAPSHOT__()`
2. 提问：原定位 + 失败原因 + 步骤目标 + 快照 + 允许的 strategy 列表
3. `chatJSON` 拿到新 `LocatorStrategy`
4. **只做 resolve-only 验证**：
   - 唯一匹配（不能 0 个/多个）
   - visible
   - enabled（若适用）
   - 元素类型与步骤 action 兼容
   - 关键文本/label/对话框上下文与目标语义一致
5. 生成 `HealCandidate`：
   - `resolveVerified=true`
   - `actionVerified=false`
   - `requiresConfirm = step.riskLevel !== 'read' || step.hasSideEffect`
6. resolve 验证失败 → 最多 `RETRY.healMax` 次后返回 null

**禁止**：T-47 里直接 click “提交/审批/删除/支付”来证明 locator 正确。

**验收**：`pnpm --filter e2e test -g "heal-resolve"`
- 把“事由”改成“加班原因” → 能生成 resolveVerified candidate
- 把提交按钮文案改掉 → 能生成 candidate，但 **submissions 数量保持 0，证明 resolve 阶段没有真的提交**。
---

#### T-48 · 自愈执行、确认、postcondition 与写回留痕
**依赖**：T-47, T-40
**交付**：`packages/llm/src/heal.ts`（续）+ `packages/core/src/skill-writer.ts`

流程：
1. 接收 `HealCandidate`
2. 若 `requiresConfirm=true` → 必须重新走 `onConfirm`；用户拒绝则不执行、不写回
3. 真正执行修复后的动作
4. 对有副作用步骤执行 step/global postcondition/assertion
5. 只有动作成功且断言通过，才把 `candidate.actionVerified=true`
6. **仅 `resolveVerified && actionVerified` 时 commit**：
   - `skill.version += 1`
   - 更新 target
   - 追加 `_healHistory`
   - 用 `yaml` 库写回并保留注释
7. 任一步骤失败 → 丢弃 candidate，不修改正式 skill.yaml

**验收**：
- read/fill 类自愈通过后能写回
- write click 自愈必须先触发确认；拒绝时 YAML 完全不变
- postcondition 失败时 YAML 完全不变
- 写回后文件仍可 `parseSkill()`，原 `# TODO` 注释还在。
---

#### T-49 · 【Stretch】J4 受限动作空间探索（不阻塞 Core Demo）
**依赖**：T-44, T-16
**交付**：`packages/llm/src/explore.ts`

> **状态：Stretch Goal。** M0–M8 Core 验收不得因本任务未完成而失败；只有项目方明确决定做 A10 时才进入。

- 动作白名单：`selectOption` `fill` `setDateTime` `click` `waitFor` `readValue` `done` `fail`
- 三重校验（C5）：zod action 白名单、idx 存在、enum 值合法
- 任一不过 → 回灌错误重试，最多 `RETRY.llmSchemaMax`
- 步数上限 `RETRY.exploreMaxSteps`
- 每步执行后重新生成快照
- 有副作用动作仍需 `onConfirm`
- 写动作同样遵守 C12，不允许 outcome_unknown 后自动重复操作

**验收（仅 Stretch 开启时）**：`pnpm --filter e2e test -g "explore"`。
---

#### T-50 · 【Stretch】探索结果固化为技能
**依赖**：T-49
**交付**：`packages/llm/src/explore.ts`（续）

> **状态：Stretch Goal。** 不阻塞 Core Demo。

探索成功后，把动作序列 + 期间捕获且已脱敏的网络请求 → 走 T-33 draft 生成逻辑 → 写 `skills/<id>.yaml`。固化前仍需 Schema 校验，动态 token 不得硬编码。

**验收（仅 Stretch 开启时）**：探索完成后出现新 skill，且能被 `dsh replay` 确定性回放。
---

#### T-51 · 主脑编排与 token 熔断（Core 不依赖 J4）
**依赖**：T-45, T-48
**可选依赖**：T-50（仅在启用 Stretch J4 时）
**交付**：`packages/cli/src/run.ts` —— `dsh run "<自然语言>"`

Core 流程：
`route → 命中 skill → replay → 定位失败时 proposeHeal → confirm/execute/assert → commit heal`

未命中 skill：
- 默认 Core 行为：明确返回 `NO_MATCHING_SKILL`，提示需先录制/创建技能
- 若检测到 Stretch T-49/T-50 已启用且配置允许：才进入 explore → 固化

其他：
- token 预算：单次任务超 `DSH_TOKEN_BUDGET`（默认 50000）熔断
- `--no-llm` 时跳过全部 LLM 环节，仅确定性回放

**验收**：
```bash
pnpm dsh run "帮我提交明天晚上6点到9点的工作日加班，事由是版本上线"
```
Core 不要求无技能探索成功；无匹配 skill 时必须可控失败而不是偷偷进入开放式 Agent 循环。
---

### M8 · 验收

---

#### T-52 · 验收用例 A1–A5 + 写操作安全专项
**依赖**：T-42
**交付**：`e2e/acceptance/a1-a5.spec.ts`
- A1 录制加班 → 产出 draft.yaml
- A2 修正后回放，`--repeat-each=10`，成功 ≥ 9
- A3 见 T-53
- A4 录制请假，复用录制器无需改代码
- A5 network 通道单次 < 2 秒
- **S1 安全专项**：`drop_response=1` 模拟“服务端已提交但响应丢失” → DSH 必须判 `outcome_unknown`/postcondition，不得自动 UI 再提交；最终 submissions 数量只能增加 1
- **S2 认证专项**：403 forbidden 不得触发登录循环或自动业务重试

**DoD**：M6 不只验证“能成功”，还必须验证“失败不制造重复业务数据”。
---

#### T-53 · A3 专项：build 后回放
**依赖**：T-52, T-08
**交付**：`e2e/acceptance/a3-rebuild.spec.ts` + `scripts/a3-loop.mjs`

```
循环 5 次：
  1. 记录当前 submitBtn class
  2. pnpm --filter mock-oa-frontend build && preview
  3. 断言 class 已变化
  4. dsh replay skills/oa_overtime_submit.yaml
  5. 断言成功
```

**验收**：`node scripts/a3-loop.mjs` 退出码 0
**DoD**：⚠️ **这是整个 Demo 最核心的验收项**

---

#### T-54 · 验收用例 A6–A12（A10 为 Stretch）
**依赖**：T-51
**交付**：`e2e/acceptance/a6-a12.spec.ts`
- A6 改按钮/label 文案 → LLM 自愈成功；5 种变更至少 4 种恢复；写动作必须验证“resolve 阶段未执行、确认+断言后才写回”
- A7 Legacy SSR 页录制回放（必须真实走 HTML preflight 提取 `__VIEWSTATE`）
- A8 Vue2 页录制回放
- A9 自然语言 → 意图路由 → 参数抽取 → 已有技能执行
- **A10【Stretch】** 无技能探索并固化；未实现 T-49/T-50 时标记 skipped，**不计入 Core 失败**
- A11 会话过期 → 登录握手 → Replay Engine 按安全规则决定是否继续；403 单独验证 forbidden
- A12 LLM 输出非法动作/非法 locator → 被 Schema/策略护栏拦截重试

**Core DoD**：A6/A7/A8/A9/A11/A12 全绿；A10 仅 Stretch 开启时要求通过。
---

#### T-55 · 交付文档
**依赖**：T-53, T-54
**交付**：
- `README.md`：安装、启动 mock、录制、回放、run 全流程
- `docs/migration-checklist.md`：v3.1 §6 表 + §7.5 载体清单，做成可勾选清单
- `docs/skill-authoring.md`：技能 YAML 手工编写与修正指南
- `docs/troubleshooting.md`：诊断包怎么看、常见失败原因；单列 `outcome_unknown`、403、登录恢复、重复提交保护、脱敏规则

**验收**：新人按 README 从零到跑通一次回放，全程无需询问；交付前确认 T-53 与 T-54 Core 均已通过。
---

## 4. 任务依赖图

```text
T-01 ─ T-02* ─┬─ T-03* ──────────────────────────────┬─ T-35 ─┬─ T-36
               │                                      │        ├─ T-37 ─┐
               ├─ T-11 ─┬─ T-12 ─┬─ T-13             │        ├─ T-38 ─┼─ T-39 ─┬─ T-40
               │        │        ├─ T-14*             │        └─ T-41  │        ├─ T-41
               │        │        ├─ T-15 ─ T-23       │                 │        └─ T-42*
               │        │        └─ T-16 ─────────────┼─────────────┐   │
               │        └─ T-17 ─┬─ T-18 ─ T-19 ─ T-20──────────────┘   │
               │                 ├─ T-21                               │
               │                 ├─ T-22*                              │
               │                 └─ T-24 ─ T-25 ─┬─ T-26 ─ T-28*       │
               │                                 └─ T-27                │
               └─ T-43 ─ T-44 ─┬─ T-45 ────────────────┐               │
                                ├─ T-46                  │               │
                                └─ T-47 ─ T-48* ────────┴─ T-51 ─ T-54* ─┐
                                                   │                      │
                              [Stretch] T-49 ─ T-50 ┘ (可选接入 T-51)    │
                                                                          ├─ T-55*
T-01 ─ T-04 ─┬─ T-05 ─┬─ T-07 ─┬─ T-10*                                │
             ├─ T-06 ─┘        └─ T-08 ─ T-53* ─────────────────────────┘
             └─ T-09

T-29 ← T-25
T-30 ← T-29
T-31 ← T-29
T-32 ← T-29
T-33 ← T-30 + T-31 + T-32
T-34 ← T-33

* = 里程碑/人工停止检查点，不通过不得继续到对应后续阶段。
```

**依赖解释**：
- `T-51` Core **必须依赖 T-48**，因为主脑的 heal 分支必须包含“确认/执行/postcondition/commit”，不能只停在 locator candidate。
- `T-49/T-50` 是 Stretch，可选接入 `T-51`；未完成时 `dsh run` 对无匹配技能返回 `NO_MATCHING_SKILL`。
- `T-55` 同时依赖 `T-53 + T-54`，确保最终交付不能绕过 rebuild 核心验收。

---

## 5. 每个里程碑的停止检查

Codex 完成一个里程碑的最后一个任务后，**必须停下来等人工确认**，不得自行进入下一里程碑。

| 里程碑 | 停止检查项 |
|---|---|
| **M0** | `pnpm build` / `pnpm test` / `pnpm -r exec tsc --noEmit` 全绿；人工复核 §2 中 `ExecutionOutcome`、`AuthState`、`PreflightSchema`、`RecordedRequest` 时间戳和 sanitizer 契约后，才允许标记“冻结” |
| **M1** | T-10 通过 = 朴素选择器确实失败；同时 T-05 依赖陷阱必须证明“跳过 approver 或复用旧 approvalToken → submit 必失败” |
| **M2** | T-14 连续 20 次通过。达不到就别往下走，定位器不稳后面全白搭 |
| **M3** | T-22 `dsh doctor` 输出可直接发给内网运维；认证四态测试全绿，403 不触发登录握手 |
| **M4** | `record.json` 动作/网络完整；请求关联所需 `requestTs` 存在；用测试 secret grep 文件不得泄漏 Authorization/Cookie/password/token |
| **M5** | T-30 正确识别 `approverId + approvalToken` 的跨请求依赖；workday 录制 → weekend replay 仍成功 |
| **M6** | A1–A5 / `--no-llm` 主路径可跑；`drop_response` 安全专项证明 **0 次自动重复提交**；403 不重试业务动作 |
| **M7 Core** | A6 自愈 ≥ 4/5；写动作 resolve 阶段 0 次副作用；A9/A11/A12 全绿 |
| **M7 Stretch** | 若项目方选择实现：A10 无技能探索+固化通过；未实现不影响 Core Gate |
| **M8** | T-53 rebuild 循环 5 次全通过 + T-54 Core 全绿；T-55 才允许完成 |

---

## 6. 常见坑位预警（给 Codex）

> 建议将本节连同 §0、§1、§2 作为 Codex 每个任务的固定上下文。以下均为**硬约束**，不是可选优化。

| 坑 | 表现 | 正确做法 |
|---|---|---|
| select 面板不在 select 内 | `selectOption` 找不到选项 | 去 `document` 根上找最后一个可见 `.el-select-dropdown` |
| 弹窗动画期间点击被吞 | 点了没反应 | `opacity===1` 后再等配置化动画缓冲 |
| date-picker 直接 `fill` 无效 | Vue 不更新 model | 用原生 setter + input/change + Enter |
| network 步骤用 Node fetch | Cookie 丢失、CORS/会话行为不一致 | **必须 `page.evaluate` 内 fetch**（C2） |
| 模板变量缺失静默变空串 | 请求参数错误但不报错 | 缺失必须抛错，结果视为 `not_sent` |
| 把所有 network catch 当失败 | 服务端可能已 commit，随后 UI 又提交一次 | 区分 `ExecutionOutcome`；连接断开/超时可能是 `outcome_unknown` |
| `outcome_unknown` 自动 fallback | 重复创建单据、重复审批/删除 | 禁止自动重放；先 postcondition，无法确认就中止人工判断 |
| Auth 层自动重跑 `fn` | 登录恢复后把写请求再发一遍 | Auth 只恢复认证；Replay Engine 决定是否 retry（C14） |
| 403 当掉登录 | 无权限用户陷入反复登录 | 403 → `forbidden`；只有 401/明确登录跳转才是 `unauthenticated` |
| sessionApi 200 就算登录 | 实际返回 SSO 登录 HTML，被误判 authenticated | 结合 `loggedInJsonPath` / login URL / DOM markers；不确定返回 `unknown` |
| 自愈未验证直接写回 | 技能库被污染且静默 | 先 resolve-only；动作+postcondition 通过后才 commit（C4） |
| 自愈“试点提交按钮” | 为验证 locator 真的产生业务写入 | write/critical resolve 阶段只能定位，不得执行；重新确认后才执行 |
| 探索循环无步数上限 | 死循环烧 token | `RETRY.exploreMaxSteps`；J4 仅 Stretch |
| 选择器生成器产出 css 兜底 | build 后失效 | 生成 css 时打警告；Mock 典型元素测试要求 0 个 css |
| 录制探针记录 select 本身 click | 多出无效动作 | `.el-select` 内 click 只记录打开状态，选项由 body 面板事件记录 |
| “approverId 校验”不够形成依赖陷阱 | 硬编码录制值仍可能同参数 replay 成功 | approver 返回动态 `approvalToken`；切换 type 回放验证必须重新取值 |
| 用 response 时间关联动作 | 慢响应被归到后一个 UI action | 只用 `requestTs`，归给最近前置 action（C15） |
| Legacy preflight 只会 JSON | `__VIEWSTATE` 无法执行 | GET HTML → DOMParser → selector/attribute 提取 |
| Record/HAR/trace 直接落盘 | Authorization/Cookie/token/password 泄漏 | 统一经过 `sanitize.ts`；依赖分析所需 token 用稳定不可逆 fingerprint，不保存原值 |
| CSRF/ViewState 被当普通参数保存 | 技能含过期/敏感动态值 | YAML 只保存“运行时如何提取”，真实值只留内存 |
| submit 只重放最终请求 | approver/balance 等联动结果缺失 | T-30 必须生成跨步依赖模板，不准硬编码动态响应值 |
| Vue2/Vue3 类名差异 | Vue2 页面定位失败 | 走 `compat.ts` 版本探测 |
| 浏览器侧代码 import npm 包 | IIFE 注入报错 | `_guard.ts` 构建时拦截 |
| LLM trace 原样记录 prompt/response | 业务数据或凭证进入日志 | 记录前统一 sanitizer；对敏感字段只保留占位符 |

---

## 7. 环境变量

```bash
# .env.example
DSH_LLM_BASE_URL=https://api.deepseek.com/v1     # 内网改为内网端点
DSH_LLM_API_KEY=sk-xxx
DSH_LLM_MODEL=deepseek-chat
DSH_TOKEN_BUDGET=50000

MOCK_OA_PORT=3000
MOCK_OA_FRONTEND_PORT=5173
MOCK_OA_VUE2_PORT=5174

DSH_PROFILE_DIR=./profiles/default
DSH_CHANNEL=chrome
```

---

## 8. 交付清单

Demo 完成时应交付：

- [ ] 可运行的 monorepo（`pnpm install && pnpm build` 即可）
- [ ] Mock OA 环境（`docker-compose up` 一键启动）
- [ ] `dsh` CLI：`doctor` `record` `analyze` `diff` `replay` `run`
- [ ] 两个技能文件：`oa_overtime_submit.yaml`、`oa_leave_submit.yaml`
- [ ] Core 验收 CI 报告：A1–A9 + A11–A12 全绿；A10 若启用 Stretch 则单独报告
- [ ] 四份文档（README + 迁移清单 + 技能编写指南 + 排障指南）
- [ ] 一段 5 分钟演示录屏：录制 → 修正 → 回放 → **rebuild 后仍能回放** → 破坏一步 → 自愈；附加展示 `drop_response` 不重复提交的安全验收结果

---

**文档结束**
