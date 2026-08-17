# DSH Recorder · Codex 开发执行计划

> 版本：1.0 ｜ 日期：2026-08-17
> 上游依据：《DSH 技术方向文档 v3.1》
> 本文档是**给编码 Agent（Codex）的执行规格**，非架构讨论文档。
> 每个任务都是一个 PR 粒度的工作单元，包含：依赖、交付文件、实现要点、验收命令、DoD。

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
│   │   └── src/{types,schema,template,constants,errors}.ts
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
│   │   └── src/{engine,channel-network,channel-ui,assert,diagnostic}.ts
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
| **M0 骨架** | W1 前半 | T-01 ~ T-03 | `pnpm build` `pnpm test` 通过 |
| **M1 Mock 环境** | W1 | T-04 ~ T-10 | 朴素选择器脚本**必须失败** |
| **M2 定位器** | W2 | T-11 ~ T-16 | 手写脚本连续 20 次跑通加班流程 |
| **M3 载体与认证** | W3 | T-17 ~ T-22 | 会话过期后自动握手恢复 |
| **M4 录制器** | W4 | T-23 ~ T-28 | 产出完整 record.json |
| **M5 分析器** | W5 | T-29 ~ T-34 | 产出 draft.yaml |
| **M6 回放器** | W6 | T-35 ~ T-42 | 确定性回放通过 A1–A5 |
| **M7 LLM 主脑** | W7 | T-43 ~ T-51 | 通过 A6、A9–A12 |
| **M8 验收** | W7 末 | T-52 ~ T-55 | A1–A12 全绿 |

---

## 1. 关键设计约束（实现时必须遵守）

| # | 约束 | 原因 |
|---|---|---|
| C1 | **channel 是步骤级属性，不是技能级** | 一个技能天然混搭 network/ui/merged |
| C2 | **network 步骤必须在页面上下文内 `fetch` 执行**，不得用 Node 侧 http 客户端 | Cookie 自动携带、同源无 CORS、内网行为一致 |
| C3 | **全链路不得依赖视觉能力**，`ILLMProvider.supportsVision` 恒可为 false | 内网 DeepSeek 无多模态 |
| C4 | **LLM 自愈必须先验证执行成功才写回 YAML** | 否则静默污染技能库 |
| C5 | **LLM 探索只能从固定动作集选择**，输出过三重校验 | 防止不可控操作 |
| C6 | **`riskLevel: write` 步骤一律停下等确认** | 无论快慢通道 |
| C7 | **定位不生成 CSS 路径，生成语义策略描述** | class 每次 build 变化 |
| C8 | **凭证不落 DSH 存储**，仅存在于浏览器 profile | 合规立足点 |
| C9 | **浏览器侧代码零依赖、零 Node API** | 需作为 IIFE 注入 |
| C10 | **所有 LLM 调用写入 `llm-trace.jsonl`** | 可复盘 |

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
    loginUrlPattern: z.string(),
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
  preflight: z.array(z.object({
    name: z.string(),
    source: z.string(),        // "meta[name=csrf-token]@content" | "$.token"
    url: z.string().optional(),
  })).default([]),
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
  ts: number;
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  postData: string | null;
  status: number;
  responseBody: string | null;
  mutating: boolean;
}
```

### 2.4 执行上下文与结果

```ts
export interface ExecContext {
  params: Record<string, any>;
  vars: Record<string, any>;              // preflight 与 step extract 产出
  stepResults: Record<string, any>;       // { s2: { approverId: 1023 } }
  baseUrl: string;
}

export interface StepResult {
  stepId: string;
  ok: boolean;
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
```

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

#### T-02 · 冻结契约类型与常量
**依赖**：T-01
**交付**：
- `packages/core/src/types.ts` —— §2.1 / 2.3 / 2.4 / 2.5 / 2.6 全部类型
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
- `packages/core/src/errors.ts` —— 错误类：`LocatorNotFoundError`、`LoginTimeoutError`、`AssertionFailedError`、`LLMValidationError`、`StepExecutionError`（每个带 `code` 字段）

**验收**：
```bash
pnpm --filter @dsh/core exec tsc --noEmit
```
**DoD**：后续任务不再新增顶层类型，只能扩展

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
  - 未登录访问 `/api/*`（除 login/session/csrf）→ 401

**验收**：
```bash
pnpm --filter mock-oa-backend dev &
curl -s localhost:3000/api/session            # {"loggedIn":false}
curl -si localhost:3000/api/overtime/types | head -1   # HTTP/1.1 401
```

---

#### T-05 · Mock 业务接口
**依赖**：T-04
**交付**：
- `GET  /api/overtime/types` → `[{value:'workday',label:'工作日加班'},{value:'weekend',label:'周末加班'},{value:'holiday',label:'节假日加班'}]`
- `POST /api/overtime/approver` `{type}` → `{approverId, approverName}`（按 type 映射到不同审批人，**K6 联动核心**）
- `POST /api/overtime/submit` → 校验 csrf + **校验 approverId 必须与 type 匹配**，返回 `{code:0, no:'OT-YYYYMMDD-NNNN'}`
- `GET  /api/leave/types`、`POST /api/leave/balance`、`POST /api/leave/submit`（同构）
- `GET  /api/overtime/history?page=&size=` → 200 条假数据（供 K9 虚拟滚动）

**实现要点**：
- `submit` 的 approverId 校验是**故意的**：这样"只重放 submit 不调 approver"必然失败，能验证依赖识别是否正确

**验收**：
```bash
# 用错误 approverId 提交必须失败
curl -X POST .../api/overtime/submit -d '{"type":"workday","approverId":9999,...}'
# → {"code":400,"msg":"审批人不匹配"}
```

---

#### T-06 · Mock Vue3 前端骨架
**依赖**：T-04
**交付**：`apps/mock-oa/frontend/`
- Vue 3 + Element Plus + Vite + vue-router
- 页面：`Login.vue` `Home.vue` `LeaveApply.vue` `OvertimeApply.vue` `History.vue`
- `index.html` 中注入 `<meta name="csrf-token" content="...">`（登录后由前端写入）
- axios 封装：自动带 `X-CSRF-TOKEN`，401 时跳登录页

**验收**：`pnpm --filter mock-oa-frontend dev` 后手动登录可进首页

---

#### T-07 · 复刻坑点 K1–K6、K10
**依赖**：T-05, T-06
**交付**：`OvertimeApply.vue` 严格按 v3.1 §2.4 实现
- K1：`el-select` 保持默认 `append-to-body`
- K2：`el-date-picker` `type="datetime"` `:editable="false"`
- K3：提交前弹 `el-dialog`，保留默认动画
- K5：提交按钮用 `<style module>` 的 class + `role="button"` + `@click`
- K6：`@change="loadApprover"` 调联动接口，结果只读展示
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
  // 记录当前 hash，供 T-55 build 后对比
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

#### T-18 · 登录状态探测
**依赖**：T-17
**交付**：`packages/browser/src/auth.ts` → `isLoggedIn(page, auth): Promise<boolean>`

优先级：
1. 配了 `sessionApi` → 页面内 `fetch` 该接口，401/403 → false；否则按 `loggedInJsonPath` 取值
2. 否则 → 当前 URL 是否匹配 `loginUrlPattern`

**验收**：`pnpm --filter e2e test -g "isLoggedIn"`（覆盖已登录 / 未登录 / 会话过期三态）

---

#### T-19 · 登录握手
**依赖**：T-18
**交付**：`packages/browser/src/auth.ts` → `ensureLoggedIn(page, auth): Promise<void>`

严格按 v3.1 §7.4：
- 未登录 → `page.bringToFront()` → 注入蓝色横幅 `#__dsh_login_hint__`
- 每 `TIMEOUTS.loginPoll` 轮询一次
- 成功 → 移除横幅并返回
- 超时 → 抛 `LoginTimeoutError`

**验收**：`pnpm --filter e2e test -g "ensureLoggedIn"`
测试脚本：调 `/api/_debug/expire` 使会话失效 → 调 `ensureLoggedIn` → 脚本模拟用户在窗口内登录 → 断言函数正常返回且横幅已移除

---

#### T-20 · 会话过期中途恢复
**依赖**：T-19
**交付**：`packages/browser/src/auth.ts` → `withSessionRecovery(page, auth, fn)`

包装任意执行函数：捕获 401/403 或跳转登录页 → 调 `ensureLoggedIn` → **重跑一次 fn**（只重试一次）

**验收**：`pnpm --filter e2e test -g "session-recovery"`

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

#### T-24 · 网络录制
**依赖**：T-17
**交付**：`packages/recorder/src/network.ts`

- `page.on('response')` 采集
- 用 `NOISE_PATTERNS` 过滤
- 非 xhr/fetch 的 GET 一律丢弃
- `responseBody` 用 `res.text().catch(() => null)`
- 标记 `mutating = method !== 'GET'`

**验收**：`pnpm --filter e2e test -g "network-record"`
断言：加班流程录制后，保留的请求数 ≤ 5，且必含 `approver` 与 `submit` 两条

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

#### T-29 · 动作-请求关联
**依赖**：T-25
**交付**：`packages/analyzer/src/correlate.ts`

```ts
export function correlate(session: RecordSession): CorrelatedStep[];
```
规则：
- 请求 ts 落在 `action.ts` 与 `action.ts + 2000ms` 之间 → 归属该 action
- 一个 action 可关联多个请求
- 无归属的请求单独列为 `orphan`（页面加载时的初始化请求）

**验收**：`pnpm --filter @dsh/analyzer test`
断言：加班录制中，`approver` 请求归属到 `select` 动作

---

#### T-30 · 副作用与依赖识别
**依赖**：T-29
**交付**：`packages/analyzer/src/correlate.ts`（续）

- `hasSideEffect`：该 action 关联了 `mutating` 请求
- **依赖识别**：遍历请求 B 的 body 所有叶子值，若某值出现在请求 A 的 responseBody 中（JSON 深度搜索），记 `B.dependsOn.push({ from: A.id, path: '$.approverId', to: 'body.approverId' })`
- 终态识别：最后一个 mutating 请求标记 `isSubmit`

**验收**：单测断言 `submit.dependsOn` 包含 `approver` 的 `$.approverId`

**DoD**：⚠️ 这是整个分析器最关键的一条。T-05 中 submit 会校验 approverId，若依赖识别失败，回放必然失败

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

- 扫描请求 headers，发现 `X-CSRF-TOKEN`/`X-XSRF-TOKEN`/`__RequestVerificationToken` → 生成 preflight 项，source 优先 `meta[name=csrf-token]@content`
- 扫描 form body，发现 `__VIEWSTATE`/`__EVENTVALIDATION` → 生成"先 GET 页面提取隐藏字段"的 preflight step
- 扫描 401/403 响应与跳转，推断 `auth.loginUrlPattern`
- 发现类似 `/api/session`、`/api/user/current` 的请求 → 建议为 `auth.sessionApi`

**验收**：单测覆盖 Vue3 场景（meta csrf）与 legacy 场景（`__VIEWSTATE`）

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

支持两类 source：
- `meta[name=csrf-token]@content` → DOM 提取（CSS 选择器 + `@属性名`）
- `$.token` → 先 GET `url` 再 JSONPath 提取

结果写入 `ctx.vars`

**验收**：单测 + e2e 断言 `ctx.vars.csrf` 非空

---

#### T-37 · network 通道执行器
**依赖**：T-35
**交付**：`packages/replayer/src/channel-network.ts`

**必须严格按 C2**：在 `page.evaluate` 内用 `fetch` + `credentials:'include'`

- 模板解析后再传入 evaluate
- `contentType: 'form'` → `URLSearchParams`
- 支持 `{{items[i].xxx}}` 数组展开（生成 `Items[0].Name` 这类字段名）
- `extract` 用 JSONPath 从响应提取，写入 `ctx.stepResults[stepId]`
- 超时 `TIMEOUTS.networkStep`

**验收**：`pnpm --filter e2e test -g "channel-network"`
断言：仅用 network 通道能完成加班提交，且 `approverId` 正确来自 s2

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

#### T-39 · merged 通道 + 降级链
**依赖**：T-37, T-38
**交付**：`packages/replayer/src/engine.ts`（续）

- `merged`：只把值写入 `ctx.vars`，不执行
- `auto`：先 network 失败降级 ui
- `network` 配了 `ui` → 失败降级重试一次
- `write`/`critical` 步骤 → 调 `onConfirm`，返回 false 则中止

**验收**：`pnpm --filter e2e test -g "fallback"`
测试：故意把 s5 的 url 改错，断言自动降级到 ui 通道并成功

---

#### T-40 · 断言引擎
**依赖**：T-35
**交付**：`packages/replayer/src/assert.ts`
支持 `httpStatus` / `jsonPath` / `textPresent` / `regexExtract`，失败抛 `AssertionFailedError`
**验收**：单测覆盖 4 种类型的成功与失败路径

---

#### T-41 · 诊断包
**依赖**：T-35
**交付**：`packages/replayer/src/diagnostic.ts`

任何失败时在 `runs/<ISO时间戳>/` 产出：
`result.json` / `step-<id>-before.png` / `step-<id>-after.png` / `step-<id>-dom.html` / `step-<id>-snapshot.txt` / `network.har` / `console.log` / `llm-trace.jsonl`（若有）

**验收**：故意破坏一步，断言 8 类文件齐全

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
- 每次调用写 `llm-trace.jsonl`：`{ts, purpose, model, messages, response, tokensEstimate, durationMs}`

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

#### T-47 · J3 失败自愈
**依赖**：T-44, T-38, T-16
**交付**：`packages/llm/src/heal.ts`

```ts
export async function heal(ctx: {
  llm, page, step: Step, error: Error, snapshot: string
}): Promise<{ healed: boolean; newTarget?: LocatorStrategy }>;
```

流程严格按 C4：
1. 抓 `__DSH_SNAPSHOT__()`
2. 提问：原定位 + 失败原因 + 步骤目标 + 快照 + 允许的 strategy 列表
3. `chatJSON` 拿到新 `LocatorStrategy`
4. **用新定位试执行该步骤**
5. 成功 → 返回 `{healed:true, newTarget}`；失败 → 重试至 `RETRY.healMax` → 返回 `{healed:false}`

**验收**：`pnpm --filter e2e test -g "heal"`
测试：把 mock 页 "事由" label 改为 "加班原因" → 回放 → 断言自愈成功

---

#### T-48 · 自愈写回与留痕
**依赖**：T-47
**交付**：`packages/llm/src/heal.ts`（续）+ `packages/core/src/skill-writer.ts`

- 仅在 `verified === true` 时写回（**C4 硬约束**）
- `skill.version += 1`
- 追加 `_healHistory` 条目
- 用 `yaml` 库写回，**保留原有注释**

**验收**：单测断言写回后文件仍可 `parseSkill()`，且原 `# TODO` 注释还在

---

#### T-49 · J4 受限动作空间探索
**依赖**：T-44, T-16
**交付**：`packages/llm/src/explore.ts`

- 动作白名单：`selectOption` `fill` `setDateTime` `click` `waitFor` `readValue` `done` `fail`
- **三重校验（C5）**：
  1. zod schema（action 名在白名单）
  2. `idx` 存在于当前快照
  3. enum 值合法性
- 任一不过 → 回灌错误重试，最多 `RETRY.llmSchemaMax`
- 步数上限 `RETRY.exploreMaxSteps`
- 每步执行后重新生成快照
- `write` 步骤仍需 `onConfirm`（**C6**）

**验收**：`pnpm --filter e2e test -g "explore"`
测试：删掉技能文件，只给自然语言目标，断言能完成加班提交

---

#### T-50 · 探索结果固化为技能
**依赖**：T-49
**交付**：`packages/llm/src/explore.ts`（续）
探索成功后，把动作序列 + 期间捕获的网络请求 → 走 T-33 的 draft 生成逻辑 → 写 `skills/<id>.yaml`
**验收**：探索完成后 `skills/` 下出现新文件，且能被 `dsh replay` 直接回放

---

#### T-51 · 主脑编排与 token 熔断
**依赖**：T-45, T-47, T-49
**交付**：`packages/cli/src/run.ts` —— `dsh run "<自然语言>"`

流程：route → 命中则 replay（失败触发 heal）→ 未命中则 explore → 固化
- token 预算：单次任务超 `DSH_TOKEN_BUDGET`（默认 50000）熔断
- `--no-llm` 时跳过全部 LLM 环节，仅确定性回放

**验收**：
```bash
pnpm dsh run "帮我提交明天晚上6点到9点的工作日加班，事由是版本上线"
```

---

### M8 · 验收

---

#### T-52 · 验收用例 A1–A5
**依赖**：T-42
**交付**：`e2e/acceptance/a1-a5.spec.ts`
- A1 录制加班 → 产出 draft.yaml
- A2 修正后回放，`--repeat-each=10`，成功 ≥ 9
- A3 见 T-53
- A4 录制请假，复用录制器无需改代码
- A5 network 通道单次 < 2 秒

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

#### T-54 · 验收用例 A6–A12
**依赖**：T-51
**交付**：`e2e/acceptance/a6-a12.spec.ts`
- A6 改按钮文案 → LLM 自愈成功并写回（5 种变更各测一次）
- A7 Legacy SSR 页录制回放
- A8 Vue2 页录制回放
- A9 自然语言 → 执行
- A10 无技能探索并固化
- A11 会话过期 → 握手 → 继续
- A12 LLM 输出非法动作 → 被拦截重试

---

#### T-55 · 交付文档
**依赖**：T-54
**交付**：
- `README.md`：安装、启动 mock、录制、回放、run 全流程
- `docs/migration-checklist.md`：v3.1 §6 表 + §7.5 载体清单，做成可勾选清单
- `docs/skill-authoring.md`：技能 YAML 手工编写与修正指南
- `docs/troubleshooting.md`：诊断包怎么看、常见失败原因

**验收**：新人按 README 从零到跑通一次回放，全程无需询问

---

## 4. 任务依赖图

```
T-01 ─┬─ T-02 ─┬─ T-03 ──────────────┬─ T-35 ─┬─ T-36
      │        │                     │        ├─ T-37 ─┐
      │        ├─ T-11 ─┬─ T-12 ─┬─ T-13      ├─ T-38 ─┼─ T-39 ─┬─ T-40
      │        │        │        ├─ T-14*     └─ T-41  │        ├─ T-41
      │        │        │        ├─ T-15 ─ T-23        │        └─ T-42*
      │        │        │        └─ T-16 ──────────┐   │
      │        │        └─ T-17 ─┬─ T-18 ─ T-19 ─ T-20 │
      │        │                 ├─ T-21             │
      │        │                 ├─ T-22            │
      │        │                 └─ T-24 ─ T-25 ─┬─ T-26 ─ T-28
      │        │                                 └─ T-27
      │        └─ T-43 ─ T-44 ─┬─ T-45 ─┐
      │                        ├─ T-46  │
      │                        ├─ T-47 ─ T-48
      │                        └─ T-49 ─ T-50
      │                                          └─ T-51 ─ T-54 ─ T-55
      └─ T-04 ─┬─ T-05 ─┬─ T-07 ─┬─ T-10*
               ├─ T-06 ─┘        └─ T-08 ─ T-53*
               └─ T-09

* = 里程碑出口，不通过不得继续
```

---

## 5. 每个里程碑的停止检查

Codex 完成一个里程碑的最后一个任务后，**必须停下来等人工确认**，不得自行进入下一里程碑。

| 里程碑 | 停止检查项 |
|---|---|
| M1 | T-10 通过 = 朴素选择器确实失败。**若它成功了，说明 mock 没坑够，回头改 T-07** |
| M2 | T-14 连续 20 次通过。达不到就别往下走，定位器不稳后面全白搭 |
| M3 | T-22 `dsh doctor` 输出可直接发给内网运维 |
| M4 | `record.json` 中动作序列与网络请求都完整 |
| M5 | T-30 依赖识别正确识别出 `approverId` 来自 approver 接口 |
| M6 | A1–A5 全绿，且 `--no-llm` 下也能跑通 |
| M7 | A6 自愈成功率 ≥ 4/5 |
| M8 | A3 循环 5 次全通过 |

---

## 6. 常见坑位预警（给 Codex）

| 坑 | 表现 | 正确做法 |
|---|---|---|
| select 面板不在 select 内 | `selectOption` 找不到选项 | 去 `document` 根上找最后一个可见 `.el-select-dropdown` |
| 弹窗动画期间点击被吞 | 点了没反应 | `opacity===1` 后再等 200ms |
| date-picker 直接 `fill` 无效 | Vue 不更新 model | 用原生 setter + input/change + Enter |
| network 步骤用 Node fetch | Cookie 丢失、CORS 报错 | **必须 `page.evaluate` 内 fetch**（C2） |
| 模板变量缺失静默变空串 | 请求参数错误但不报错 | 缺失必须抛错 |
| 自愈未验证直接写回 | 技能库被污染且静默 | 验证通过才写（C4） |
| 探索循环无步数上限 | 死循环烧 token | `RETRY.exploreMaxSteps` |
| 选择器生成器产出 css 兜底 | build 后失效 | 生成 css 时打警告；测试断言 0 个 css |
| 录制探针记录 select 本身的 click | 多出无效动作 | `.el-select` 内的 click 直接 return |
| submit 校验 approverId | 只重放 submit 必失败 | 这是**故意设计**，用于验证依赖识别 |
| Vue2/Vue3 类名差异 | Vue2 页面定位失败 | 走 `compat.ts` 版本探测 |
| 浏览器侧代码 import 了 npm 包 | IIFE 注入报错 | `_guard.ts` 构建时拦截 |

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
- [ ] A1–A12 验收测试全绿的 CI 报告
- [ ] 四份文档（README + 迁移清单 + 技能编写指南 + 排障指南）
- [ ] 一段 5 分钟演示录屏：录制 → 修正 → 回放 → **rebuild 后仍能回放** → 破坏一步 → 自愈

---

**文档结束**
