# DSH Recorder · 开发执行规格 v2.0（完整合并版）

> 版本：2.0 ｜ 日期：2026-08-19
> 合并来源：v1.0 初版 + v1.1 GPT 修订 + v1.2 补丁 + v1.3 补丁
> 上游依据：《DSH 技术方向文档 v3.1》
> **执行模型：GLM。本文档已针对该模型强化约束表述，每个任务包含明确的「禁止清单」。**
>
> 本文档是**唯一权威规格**，取代此前所有版本。不需要参考任何其他文档。

---

# 第零部分 · 执行须知（每个任务开始前必读）

## 0.1 你的身份与边界

你是这个项目的编码执行者。你的职责是**严格按规格实现**，不是设计架构。

**当你遇到规格没写清楚的地方**：停下来，在 PR 描述中提出问题，**不要自己发挥**。

**当你觉得规格有更好的做法**：停下来提出，等确认后再改。**不要先改了再说**。

这个项目已经因为「实现者自己想了个更方便的办法」而返工过一次——详见 §0.3 的真实事故。

## 0.2 执行规则（硬性）

1. **一次只做一个任务。** 任务 ID 写进 commit message：`feat(T-12): implement el-locator selectOption`
2. **不得跳过依赖。** 任务的 `依赖` 字段列出的任务必须已完成且验收通过。
3. **不得擅自引入新依赖。** 若确需新增，在 PR 描述中单列一节说明理由，等确认。
4. **不得修改已冻结的契约**（第二部分的类型定义）。发现问题就停下来提，不要自行改动。
5. **每个任务必须自带测试**，`pnpm test` 全绿才算完成。
6. **浏览器侧代码**（`packages/locator`）不得使用任何 Node API，不得 import npm 包。
7. **所有超时、重试次数、延迟必须是 `constants.ts` 中的具名常量**，不得硬编码在逻辑中间。
8. 注释和文档字符串用中文，代码标识符用英文。
9. **每完成一个里程碑的最后一个任务，必须停下等人工确认**，不得自行进入下一里程碑。

## 0.3 真实事故：为什么规格写得这么死

2026-08-19 的一次真实环境测试中，执行模型被要求「登录 Keycloak 后创建一个客户端 ID」。它是这样实现的：

```
❌ 实际做法：用 admin/admin 走 password grant 换 Bearer token
            → 调 Admin REST API 直接创建客户端
```

功能上跑通了。但这个做法：

- **违反 C8**：DSH 存储了密码
- **否定了整个项目的存在理由**：如果可以直接拿账密调 API，那不需要录制器、不需要定位器、不需要这九周——直接做 API 封装就行了
- **绕开了真正要测的东西**：任务目标是验证 SSO 场景，而这个实现恰恰是「不走 SSO」

**这次事故的根因不是模型能力，是规格没有把边界写死。** 所以本版文档增加了 C16–C23 八条约束，并在每个相关任务加了「禁止清单」。

**请把这段当成你的行为基线：当你发现「有个更简单的办法能让它跑通」时，先检查这个办法是不是绕开了项目要解决的问题本身。**

## 0.4 项目一句话定位

> **在用户已登录的真实浏览器里，把业务流程录制成可重放的技能文件。**

拆解成三个不可让步的点：

| 点 | 含义 | 违反的表现 |
|---|---|---|
| **用户已登录** | DSH 永不接触凭证，永不代替用户登录 | 出现 password / token 换取代码 |
| **真实浏览器** | 所有请求在页面上下文内发出 | 出现 Node 侧 http 客户端调业务接口 |
| **可重放** | 回放时零 LLM 参与，确定性执行 | 回放依赖模型即时决策 |

## 0.5 技术栈（固定，不得替换）

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
| Mock 前端 v2（条件） | Vue 2.7 + Element UI 2.15 |
| Mock 后端 | Express 4 + express-session |
| LLM SDK | `openai`（DeepSeek 走 OpenAI 兼容端点） |

## 0.6 仓库结构

```
dsh-recorder/
├── package.json                  # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
├── playwright.config.ts
├── .env.example
├── packages/
│   ├── core/
│   │   └── src/{types,schema,template,constants,errors,sanitize,skill-writer}.ts
│   ├── locator/                  # 浏览器侧脚本（IIFE 产物）
│   │   ├── src/{el-locator,compat,recorder-probe,selector-generator,snapshot,_guard}.ts
│   │   └── build.mjs
│   ├── browser/
│   │   └── src/{context,auth,entry,bearer,probe-session,cdp}.ts
│   ├── recorder/
│   │   └── src/{session,network,index}.ts
│   ├── analyzer/
│   │   └── src/{correlate,params,preflight,draft}.ts
│   ├── replayer/
│   │   └── src/{engine,channel-network,channel-ui,preflight,assert,reentry,diagnostic}.ts
│   ├── llm/
│   │   └── src/{provider,guard,route,annotate,heal,explore}.ts
│   └── cli/
│       └── src/{index,record,analyze,replay,diff,doctor,run}.ts
├── apps/mock-oa/
│   ├── frontend/                 # Vue3 + Element Plus
│   ├── frontend-vue2/            # 【条件启用】Vue2 + Element UI
│   ├── backend/                  # Express
│   └── docker-compose.yml
├── entries/                      # entry 配置（认证载体，不属于技能）
├── skills/                       # 技能 YAML 产物
├── profiles/                     # 浏览器 profile（gitignore）
├── runs/                         # 诊断包输出（gitignore）
└── e2e/                          # 验收测试
```

## 0.7 里程碑总览（9 周）

| 里程碑 | 周 | 任务 | 出口标准（不达标不得继续） |
|---|---|---|---|
| **M0 骨架** | W1 前半 | T-01 ~ T-03 | build/test/tsc 全绿；第二部分契约人工确认后冻结 |
| **M1 Mock 环境** | W1 | T-04 ~ T-10 | 朴素选择器**必须失败**；依赖陷阱能阻止跳过 approver |
| **M2 定位器** | W2 | T-11 ~ T-16 | 手写脚本连续 20 次跑通加班流程 |
| **M3 载体与认证** | W3–W4 | T-17 ~ T-22, T-56 ~ T-58 | 认证四态可区分；403 不触发登录；sessionType 探测可用 |
| **M4 录制器** | W5 | T-23 ~ T-28 | record.json 完整；`sanitizeMode` 全为 structured |
| **M5 分析器** | W6 | T-29 ~ T-34 | 依赖识别含 approvalToken；draft 含 postcondition 或明确 TODO |
| **M6 回放器** | W7–W8 | T-35 ~ T-42, T-59 | A1–A5 通过；所有安全场景 submissions 均为 1 |
| **M7 LLM Core** | W9 | T-43 ~ T-48, T-51 | A6/A9/A11/A12 通过；自愈 resolve/action 分离 |
| **M8 验收** | W9 末 | T-52 ~ T-55 | Core 全绿 |
| **Stretch（可选）** | — | T-49, T-50, T-60, T-09b, T-13 | 不阻塞 Core |

## 0.8 每个任务的自检清单

**开始写代码前，先回答这五个问题**：

1. 我要写的代码里，有没有出现密码、client_secret、grant_type=password？→ 有则停止，违反 C17
2. 我要发的业务请求，是在 `page.evaluate` 里发的吗？→ 不是则停止，违反 C2
3. 我写的技能步骤里，有没有「打开登录页」「填账号密码」？→ 有则停止，违反 C16
4. 我用的超时/重试数字，是从 `constants.ts` 取的吗？→ 不是则改
5. 这个任务的依赖都完成了吗？→ 没有则先做依赖

---

# 第一部分 · 架构约束（C1–C23）

**这 23 条是不可协商的。任何实现与之冲突，一律以约束为准。**

| # | 约束 | 原因 | 违反的典型表现 |
|---|---|---|---|
| **C1** | channel 是**步骤级**属性，不是技能级 | 一个技能天然混搭 network/ui/merged | 整个技能只有一个 channel 字段 |
| **C2** | network 步骤**必须在页面上下文内 `fetch` 执行**，不得用 Node 侧 http 客户端 | Cookie 自动携带、同源无 CORS、内网行为一致 | 用 axios/node-fetch 调业务接口 |
| **C3** | 全链路**不得依赖视觉能力**，`supportsVision` 恒可为 false | 内网 DeepSeek 无多模态 | 给 LLM 发截图 |
| **C4** | LLM 自愈必须**先 resolve-only 验证**；有副作用动作必须重新确认并 postcondition 通过后才写回 YAML | 防止「为验证而执行」产生真实业务写入 | 为验证 locator 正确而点了「提交」 |
| **C5** | LLM 探索只能从**固定动作集**选择，输出过三重校验；J4 属 Stretch | 防止不可控操作 | 让 LLM 自由生成选择器或代码 |
| **C6** | `riskLevel: write/critical` 步骤**一律停下等确认** | 无论快慢通道；自愈后的写动作也不能绕过 | 加个 `--yes` 全局跳过 |
| **C7** | 定位**不生成脆弱 CSS 路径**，优先语义策略描述 | class 每次 build 变化 | 生成 `._submitBtn_1x9km_12` |
| **C8** | **凭证不落 DSH 存储**，仅存在于浏览器 profile / 页面上下文 | 合规立足点 | 配置文件里写密码 |
| **C9** | 浏览器侧代码**零依赖、零 Node API** | 需作为 IIFE 注入 | locator 包里 import lodash |
| **C10** | 所有 LLM 调用写入 `llm-trace.jsonl`，**但落盘前必须脱敏** | 可复盘且不泄漏 | 原样记录 prompt |
| **C11** | 所有 Record / HAR / Diagnostic / LLM Trace **落盘前统一经过 sanitizer** | Authorization、Cookie、password、token 不得持久化 | 各包自写脱敏 |
| **C12** | 写操作失败**不能等价为「未执行」**；必须区分 `not_sent / confirmed_success / confirmed_failure / outcome_unknown` | `outcome_unknown` 自动 fallback 会重复提交业务单据 | catch 就当失败然后重试 |
| **C13** | 认证状态必须是**四态**：`authenticated / unauthenticated / forbidden / unknown`；**403 不得当掉登录** | 避免权限不足被误判为会话过期 | `if (401 \|\| 403) 未登录` |
| **C14** | Session Recovery **只恢复认证，不擅自重放业务动作**；是否 retry 由 Replay Engine 按 `ExecutionOutcome` 决策 | 统一写操作安全语义 | `withSessionRecovery(fn)` 自动重跑 fn |
| **C15** | 动作-请求关联**必须用 request 发起时间**，不得用 response 到达时间 | 慢响应会错归属到后续动作 | 只挂 `page.on('response')` |
| **C16** | **技能不得包含登录环节。技能起点恒为「已通过 entry 进入目标系统、会话已建立」** | 登录是载体职责。把登录放进技能会逼出「自动登录」需求，进而滑向存储凭证 | 技能第一步是「打开登录页」 |
| **C17** | **禁止任何形式的凭证换取**：`grant_type=password`、`client_secret`、明文密码、API Key 直连。`parseSkill()` **在 Schema 层面拒绝** | 一旦允许，整个架构失去存在理由 | ⚠️ **这是 §0.3 事故的直接对应约束** |
| **C18** | C2 的 `credentials:'include'` **仅对 `sessionType: cookie` 成立**。bearer 内存态系统 network 通道不可用，强制 `channel: ui` | keycloak-js 的 token 既不在 cookie 也不在 storage | 假设所有系统都能靠 cookie 认证 |
| **C19** | **一次性认证跳转 URL**（`?token=` / `?ticket=` / `/sso/callback` / `/sso/redirect`）必须排除在技能之外，禁止录制、禁止重放 | 一次性 token 换完 session 即失效 | 把带 token 的跳转 URL 录进技能 |
| **C20** | 预授权（模式 B）**不覆盖 `riskLevel: critical`** | 无人值守时出错无人发现 | 让审批/删除走预授权 |
| **C21** | 认证恢复后**必须校验身份一致性**，不一致强制中止 | 切换身份后继续跑旧流程 = 用别人身份提交单据 | 恢复后直接继续 |
| **C22** | **重入 = 从锚点重跑幂等前缀，不是从断点继续** | 表单值、弹窗态、联动结果在重新登录后全部丢失 | 记录断点 stepId 然后从那继续 |
| **C23** | 二期自动填充只允许「从外部保管库取用 → 注入浏览器登录表单 → 立即清除内存」 | 二期做的是「代替用户敲键盘」，不是「代替用户拥有凭证」 | 二期时搞个配置文件存密码 |

---

# 第二部分 · 冻结契约

**这些类型是任务之间的接口。T-02/T-03 先实现，后续任务一律依赖，不得擅改。**

## 2.1 定位策略

```ts
// packages/core/src/types.ts

export type ControlKind =
  | 'input' | 'textarea' | 'select' | 'datepicker'
  | 'radio' | 'checkbox' | 'button' | 'text';

export type LocatorStrategy =
  | { strategy: 'el-form-item'; label: string; kind: ControlKind }
  | { strategy: 'el-option'; text: string; ownerLabel: string }
  | { strategy: 'el-dialog-scoped'; dialogTitle: string; inner: LocatorStrategy }
  | { strategy: 'el-table-cell'; rowAnchorText: string; buttonText: string }
  | { strategy: 'text'; text: string; exact?: boolean; nth?: number }
  | { strategy: 'role'; role: string; name: string }
  | { strategy: 'css'; selector: string };          // 兜底，录制器尽量不产出
```

## 2.2 Entry（认证载体，**不属于技能**）

```ts
// packages/core/src/schema.ts

export const BearerSourceSchema = z.object({
  strategy: z.enum(['storage', 'global', 'cdp-inherit', 'ui-only']),
  key: z.string().optional(),          // storage 策略的键名正则
  globalPath: z.string().optional(),   // global 策略，如 "keycloak.token"
  triggerUrl: z.string().optional(),   // cdp-inherit 策略的诱发端点
});

export const EntrySchema = z.object({
  entry: z.object({
    id: z.string(),
    name: z.string(),

    via: z.enum(['portal', 'direct']),
    portalUrl: z.string().optional(),      // via=portal
    linkText: z.string().optional(),       // via=portal，门户上的入口链接文字
    directUrl: z.string().optional(),      // via=direct

    landingUrlPattern: z.string(),

    /** 【C19】必须排除的一次性认证跳转 */
    excludeUrlPatterns: z.array(z.string())
      .default(['\\?token=', '\\?ticket=', '/sso/callback', '/sso/redirect']),

    /** 【C18】由 dsh doctor --probe-entry 探测得出 */
    sessionType: z.enum(['cookie', 'bearer', 'mixed', 'unknown']).default('unknown'),
    bearerSource: BearerSourceSchema.optional(),
    channelCapability: z.object({
      network: z.boolean(),
      ui: z.boolean().default(true),
    }).optional(),

    /** 会话存活探测 */
    sessionProbe: z.object({
      url: z.string(),
      jsonPath: z.string().optional(),
      okStatus: z.array(z.number()).default([200]),
    }),

    /** 【C21】身份一致性探测 */
    identityProbe: z.object({
      url: z.string(),
      jsonPath: z.string(),              // 优先 $.sub，其次 $.preferred_username
    }),

    loginUrlPatterns: z.array(z.string()).default([]),
    loginDomMarkers: z.array(z.string()).optional(),
    loginTimeoutMs: z.number().default(300_000),

    /** 【二期预留，一期恒 none】 */
    credentialProvider: z.object({
      type: z.enum(['none', 'vault', 'os-keychain', 'enterprise-sso-agent']).default('none'),
      ref: z.string().default(''),
      ttlMs: z.number().default(30_000),
    }).default({ type: 'none', ref: '', ttlMs: 30_000 }),
  }),
});

export type Entry = z.infer<typeof EntrySchema>;
```

## 2.3 Preflight

```ts
export const PreflightSchema = z.object({
  name: z.string(),
  /** 省略 request = 从当前页面 DOM 提取 */
  request: z.object({
    method: z.enum(['GET', 'POST']).default('GET'),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }).optional(),
  extract: z.discriminatedUnion('type', [
    z.object({ type: z.literal('dom'), selector: z.string(), attribute: z.string().default('value') }),
    z.object({ type: z.literal('jsonPath'), path: z.string() }),
    z.object({ type: z.literal('regex'), pattern: z.string(), group: z.number().default(1) }),
  ]),
});
```

**三种组合的语义**：
- 当前页 CSRF meta：无 `request` + `extract.type=dom`
- Legacy `__VIEWSTATE`：`request: GET` HTML → `extract.type=dom` 解析返回的 HTML
- JSON token 接口：`request: GET` → `extract.type=jsonPath`

## 2.4 Postcondition（响应丢失时的幂等确认查询）

```ts
export const PostconditionSchema = z.object({
  /** 只允许 GET，防止后置查询本身产生副作用 */
  request: z.object({
    method: z.literal('GET'),
    url: z.string(),
    headers: z.record(z.string()).optional(),
  }),
  match: z.object({
    jsonPath: z.string(),                   // 候选集合，例 "$.list[*]"
    where: z.record(z.string()),            // 字段条件，值支持模板
    limit: z.number().optional(),
  }),
  expectFound: z.boolean().default(true),
  timeoutMs: z.number().default(10_000),
});
```

## 2.5 Step 与 Skill

```ts
export const UiActionSchema: z.ZodType<any> = z.lazy(() => z.object({
  action: z.enum(['navigate','click','fill','selectOption','setDateTime','waitFor','readValue']),
  url: z.string().optional(),
  target: LocatorStrategySchema.optional(),
  label: z.string().optional(),            // el-form-item 快捷写法
  kind: ControlKindSchema.optional(),
  value: z.string().optional(),
  waitFor: z.object({
    selector: z.string().optional(),
    notEmpty: z.boolean().optional(),
    timeoutMs: z.number().optional(),
  }).optional(),
  preAction: UiActionSchema.optional(),
  extract: z.record(z.string()).optional(),
}));

export const StepSchema = z.object({
  id: z.string(),
  desc: z.string(),
  channel: z.enum(['network', 'ui', 'merged', 'auto']),
  riskLevel: z.enum(['read', 'write', 'critical']).default('read'),
  hasSideEffect: z.boolean().default(false),

  /**
   * 【C22】重跑是否无副作用。
   * 未显式声明时按 riskLevel 推导：read → true，write/critical → false
   */
  idempotent: z.boolean().optional(),

  network: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'DELETE']),
    url: z.string(),
    headers: z.record(z.string()).optional(),
    contentType: z.enum(['json', 'form']).default('json'),
    body: z.record(z.any()).optional(),
    extract: z.record(z.string()).optional(),
  }).optional(),

  ui: UiActionSchema.optional(),

  /** 步骤级 postcondition，优先于技能级 */
  postcondition: PostconditionSchema.optional(),
});

export const ReentrySchema = z.object({
  strategy: z.enum(['restart-from-anchor', 'abort']).default('restart-from-anchor'),
  /** 【C21】身份变更时强制中止 */
  identityLock: z.boolean().default(true),
  /** 重跑起点。该步骤及之前所有步骤必须 idempotent */
  anchor: z.string(),
  maxReentries: z.number().default(2),
});

export const SkillSchema = z.object({
  skill: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    system: z.string(),
    baseUrl: z.string(),
    /** 【C16】引用 entries/<id>.yaml，技能内不再有 auth 段 */
    entry: z.string(),
    version: z.number().default(1),
    recordedAt: z.string().optional(),
  }),
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
  postcondition: PostconditionSchema.optional(),
  reentry: ReentrySchema.optional(),
  _healHistory: z.array(z.object({
    at: z.string(), step: z.string(), reason: z.string(),
    old: z.any(), new: z.any(), verified: z.boolean(), model: z.string(),
  })).optional(),
  _notes: z.array(z.string()).optional(),
});

export type Skill = z.infer<typeof SkillSchema>;
```

## 2.6 录制会话产物

```ts
export interface RecordSession {
  meta: { startedAt: string; endedAt: string; baseUrl: string; userAgent: string; entryId: string };
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
  /** 【C15】动作关联只用这个字段 */
  requestTs: number;
  /** 仅用于耗时/诊断；响应丢失时为 null */
  responseTs: number | null;
  method: string;
  url: string;                           // 已经过 sanitizeUrl
  resourceType: string;
  headers: Record<string, string>;       // 已脱敏
  postData: string | null;               // 已脱敏
  status: number | null;
  responseBody: string | null;           // 已脱敏
  mutating: boolean;
  networkError?: string;
  /** structured = 结构化逐字段脱敏；fallback = 整串正则兜底 */
  sanitizeMode: 'structured' | 'fallback' | 'none';
}
```

## 2.7 执行上下文与结果

```ts
export type AuthState = 'authenticated' | 'unauthenticated' | 'forbidden' | 'unknown';

export type ExecutionOutcome =
  | 'not_sent'            // 明确未发出，可安全重试/降级
  | 'confirmed_success'   // 已由响应或 postcondition 确认成功
  | 'confirmed_failure'   // 明确失败，且可证明未产生目标副作用
  | 'outcome_unknown';    // 请求可能已到服务端，但客户端无法确认结果

export interface ExecContext {
  params: Record<string, any>;
  vars: Record<string, any>;
  stepResults: Record<string, any>;
  baseUrl: string;
  entry: Entry;
  identityDigest: string;                // 【C21】执行开始时记录
}

export interface StepResult {
  stepId: string;
  ok: boolean;
  outcome: ExecutionOutcome;
  channelUsed: 'network' | 'ui' | 'merged';
  durationMs: number;
  error?: string;
  healed?: boolean;
  outcomeResolvedBy?: 'response' | 'postcondition';
  postconditionResult?: any;
  raw?: { status?: number; text?: string };
}

export interface RunResult {
  ok: boolean;
  skillId: string;
  steps: StepResult[];
  extracted: Record<string, any>;
  reentryCount: number;
  diagnosticDir?: string;
}

export interface HealCandidate {
  stepId: string;
  oldTarget: LocatorStrategy;
  newTarget: LocatorStrategy;
  /** 仅验证唯一匹配/可见/enabled/语义，不代表已执行 */
  resolveVerified: boolean;
  /** 真正动作 + postcondition 已通过后才为 true */
  actionVerified: boolean;
  requiresConfirm: boolean;
  model: string;
}
```

**统一安全语义（C12）**：
- 只有 `not_sent`，或能证明「无目标副作用」的 `confirmed_failure`，才允许自动 retry/fallback
- `outcome_unknown` 禁止自动切 UI 或重放写请求，必须先跑 postcondition
- Auth 模块只报告 `AuthState` 与完成登录握手，不决定业务动作是否重跑（C14）

## 2.8 LLM Provider

```ts
export interface LLMMessage { role: 'system' | 'user' | 'assistant'; content: string }

export interface ILLMProvider {
  name: string;
  supportsVision: boolean;               // 【C3】内网恒为 false，任何代码不得依赖其为 true
  chat(messages: LLMMessage[], opts?: {
    jsonSchema?: object;
    temperature?: number;
    maxTokens?: number;
  }): Promise<string>;
}
```

## 2.9 浏览器侧全局对象

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
    __DSH_RECORD__?: (action: any) => void;
    __DSH_RECORDING__?: boolean;
  }
}
```

## 2.10 常量

```ts
// packages/core/src/constants.ts

export const TIMEOUTS = {
  waitForDefault:        5_000,
  selectPanel:           3_000,
  dialogAnimation:         200,
  afterSelect:             120,
  afterDateTime:           100,
  navigation:           30_000,
  /** 导航稳定判定：URL 保持不变多久才认为跳转结束 */
  navigationSettle:      1_500,
  navigationSettleMax:  30_000,
  loginPoll:             1_500,
  loginTotal:          300_000,
  networkStep:          15_000,
  entryProbe:           10_000,
  bearerFetch:           3_000,
} as const;

export const RETRY = {
  stepMax:         2,
  healMax:         2,
  llmSchemaMax:    3,
  exploreMaxSteps: 20,
} as const;

export const DEPENDENCY = {
  weakValueThreshold: 3,
  minStringLength:    6,
  minNumberAbs:    1000,
} as const;

export const NOISE_PATTERNS: RegExp[] = [
  /\.(js|css|png|jpe?g|gif|svg|woff2?|ttf|ico|map)(\?|$)/i,
  /\/(heartbeat|ping|track|collect|analytics|log|sockjs|__vite)/i,
];
```

---

# 第三部分 · 任务清单

格式：**依赖** / **交付** / **实现要点** / **❌ 禁止** / **验收** / **DoD**

---

## M0 · 项目骨架

### T-01 · 初始化 monorepo 骨架

**依赖**：无

**交付**：
- `package.json`（workspace root，scripts: `build` `test` `lint` `e2e`）
- `pnpm-workspace.yaml`、`tsconfig.base.json`（strict、paths 映射 `@dsh/*`）
- `vitest.config.ts`、`.eslintrc.cjs`、`.prettierrc`
- `.gitignore`（含 `runs/`、`profiles/`、`.env`）
- `.env.example`
- `packages/*/package.json` 与空 `src/index.ts`（8 个包）

**实现要点**：所有包 `"type": "module"`；包名统一 `@dsh/core`、`@dsh/locator` …

**❌ 禁止**：不要在本任务里写任何业务逻辑，只建骨架。

**验收**：`pnpm install && pnpm build && pnpm test`

**DoD**：8 个包能被 import，`pnpm -r exec tsc --noEmit` 无错误。

---

### T-02 · 冻结契约类型、常量与安全基础设施

**依赖**：T-01

**交付**：
- `packages/core/src/types.ts` —— §2.1 / 2.6 / 2.7 / 2.8 / 2.9 全部类型
- `packages/core/src/constants.ts` —— §2.10 全部常量
- `packages/core/src/errors.ts` —— 错误类，每个带 `code` 字段：
  `LocatorNotFoundError` / `LoginTimeoutError` / `AssertionFailedError` / `LLMValidationError` / `StepExecutionError` / `OutcomeUnknownError` / `ForbiddenError` / `IdentityChangedError` / `SchemaViolationError` / `BearerUnavailableError`
- `packages/core/src/sanitize.ts` —— 全链路统一脱敏器

**sanitize 规格（必须严格按此实现）**：

```
【处理顺序：必须先结构化解析，再逐字段处理。不得对整串做正则。】

1. Header map → 逐 key 判断，命中
   authorization|cookie|set-cookie|x-api-key|proxy-authorization|x-csrf-token
   → 值替换为 fingerprint(value)

2. URL → sanitizeUrl()，query 参数逐个判断，命中敏感名的替换

3. postData / responseBody → 先按 content-type 解析：
   - application/json        → JSON.parse，递归遍历叶子
   - x-www-form-urlencoded   → URLSearchParams 解析成 kv，逐值处理
   - multipart/form-data     → 解析 part，逐 part 处理
   - text/html               → 只对 input[type=hidden] 的 value 处理（ViewState）
   - 解析失败                 → 才退化到整串正则，
                               并标记 sanitizeMode: 'fallback'

4. 逐字段判断：key 命中
   password|passwd|access_token|refresh_token|token|session|secret|api_key
   |__VIEWSTATE|__EVENTVALIDATION|__RequestVerificationToken
   → 值替换为 fingerprint(value)

5. 【双层转义处理】除直接匹配 "key":"value" 外，
   还须处理转义形态 \"key\":\"value\" 及多层嵌套。
   实现：先尝试 JSON.parse 展开内嵌字符串，成功则递归处理；
        失败再用转义正则兜底。

6. fingerprint(value) 定义：
   `<REDACTED:sha256:${sha256(salt + value).slice(0,12)}>`
   - salt 为单次录制会话内的随机值，存于内存，不落盘
   - 同一会话内：同一原值 → 同一 fingerprint（保证依赖识别可用）
   - 跨会话：同一原值 → 不同 fingerprint（防止跨录制关联反推）
   - 不可逆
```

**同时交付** `assertNoPlainCredentials()`（供 T-03 的 `parseSkill` 调用）：

```ts
const FORBIDDEN_KEYS = /^(password|passwd|pwd|secret|client_?secret|credential|api_?key)$/i;
const FORBIDDEN_VALUES = /grant_type\s*=\s*password|"grant_type"\s*:\s*"password"/i;

export function assertNoPlainCredentials(node: any, path = 'root'): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (FORBIDDEN_VALUES.test(node)) {
      throw new SchemaViolationError(
        `[C17] ${path} 含凭证换取语义（grant_type=password），禁止。技能不得包含登录环节，见 C16。`
      );
    }
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.test(k)) {
      throw new SchemaViolationError(
        `[C17] ${path}.${k} 是明文凭证字段，禁止出现在技能中。二期自动填充请用 credentialProvider.ref。`
      );
    }
    assertNoPlainCredentials(v, `${path}.${k}`);
  }
}
```

**❌ 禁止**：
- 不得让各包自写脱敏（C11）
- 不得对 postData 整串做正则脱敏（会破坏 T-30 的依赖识别）
- 不得把 salt 写入任何文件

**验收**：
```bash
pnpm --filter @dsh/core exec tsc --noEmit
pnpm --filter @dsh/core test
```

必须包含以下测试：

```ts
it('跨编码格式的同一 token 必须产生相同 fingerprint', () => {
  const token = 'tk_9f3a2c8e1b';
  const s = createSanitizer();
  const resp = s.sanitizeBody(JSON.stringify({ approverId: 1023, approvalToken: token }),
                              'application/json');
  const req = s.sanitizeBody(`type=workday&approverId=1023&approvalToken=${token}`,
                             'application/x-www-form-urlencoded');
  const fpResp = JSON.parse(resp).approvalToken;
  const fpReq  = new URLSearchParams(req).get('approvalToken');
  expect(fpResp).toMatch(/^<REDACTED:sha256:[0-9a-f]{12}>$/);
  expect(fpReq).toBe(fpResp);                       // ← 关键
});

it('双层转义的 JWT 必须被脱敏（Keycloak 实测回归）', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.sig';
  const inner = JSON.stringify({ access_token: jwt, expires_in: 60 });
  const outer = JSON.stringify({ status: 200, text: inner });
  const out = createSanitizer().sanitizeBody(outer, 'application/json');
  expect(out).not.toContain(jwt);
  expect(out).not.toContain('eyJhbGciOiJSUzI1NiJ9');
});

it('三层嵌套同样不得泄漏', () => { /* 同上，三层 */ });

it('URL query 中的 token 被处理，非敏感参数保留', () => {
  const url = createSanitizer().sanitizeUrl('/api/x?approvalToken=tk_abc&type=workday');
  expect(url).toContain('<REDACTED:sha256:');
  expect(url).toContain('type=workday');
});

it('正常业务字段不被误伤', () => {
  const out = createSanitizer().sanitizeBody(
    JSON.stringify({ passengerName: '张三', secretary: '李四' }), 'application/json');
  expect(out).toContain('张三');
  expect(out).toContain('李四');
});

it('assertNoPlainCredentials 拦截 grant_type=password 与凭证字段名', () => { /* ... */ });
```

**DoD**：后续不得擅自修改跨包冻结契约；任何落盘内容必须复用 `sanitize.ts`。

---

### T-03 · Skill / Entry Schema 与模板引擎

**依赖**：T-02

**交付**：
- `packages/core/src/schema.ts` —— §2.2 / 2.3 / 2.4 / 2.5 全部 zod schema
- `parseSkill(yamlText, entryResolver): Skill`
- `parseEntry(yamlText): Entry`
- `packages/core/src/template.ts`

**`parseSkill` 必须执行的三项校验**：

```ts
export function parseSkill(yamlText: string, entryResolver: (id: string) => Entry): Skill {
  const skill = SkillSchema.parse(YAML.parse(yamlText));
  const entry = entryResolver(skill.skill.entry);

  // 【C17】明文凭证拒绝
  assertNoPlainCredentials(skill.steps, 'steps');
  assertNoPlainCredentials(skill.preflight, 'preflight');

  // 【C18】bearer 内存态系统禁止 network 通道
  const netUnavailable = entry.entry.sessionType === 'bearer'
                      && entry.entry.bearerSource?.strategy === 'ui-only';
  if (netUnavailable) {
    const bad = skill.steps.filter(s => s.channel === 'network' || s.channel === 'auto');
    if (bad.length) {
      throw new SchemaViolationError(
        `[C18] entry "${entry.entry.id}" 的 sessionType=bearer/ui-only，network 通道不可用。` +
        `以下步骤必须改为 channel: ui —— ${bad.map(s => s.id).join(', ')}`
      );
    }
  }

  // 【C22】anchor 之前的步骤必须幂等
  if (skill.reentry) {
    const idx = skill.steps.findIndex(s => s.id === skill.reentry!.anchor);
    if (idx < 0) throw new SchemaViolationError(`reentry.anchor "${skill.reentry.anchor}" 不存在`);
    const bad = skill.steps.slice(0, idx + 1)
      .filter(s => !(s.idempotent ?? (s.riskLevel === 'read')));
    if (bad.length) {
      throw new SchemaViolationError(
        `[C22] anchor 之前存在非幂等步骤：${bad.map(s => s.id).join(', ')}。` +
        `重入会重跑这些步骤并产生重复副作用。请把 anchor 前移，或标记这些步骤为幂等。`
      );
    }
  }
  return skill;
}
```

**`parseEntry` 必须执行**：`credentialProvider.type !== 'none'` 时抛 `NotImplementedError`（二期能力）。

**模板引擎规格**：
```
{{paramName}}                    → params.paramName
{{s2.approverId}}                → stepResults.s2.approverId
{{csrf}}                         → vars.csrf
{{type|enumValue}}               → 枚举 label → value 映射
{{startTime|date:YYYY-MM-DD}}    → 日期格式化
{{items[i].name}}                → 数组循环占位（由 network 执行器展开）
```

**❌ 禁止**：
- 未解析到的变量**必须抛错**，不得静默替换为空字符串
- `resolveTemplate` 必须返回深拷贝，不得修改原对象

**验收**：`pnpm --filter @dsh/core test`

测试至少覆盖：普通参数、跨步引用、preflight 变量、enumValue、date 过滤器、**变量缺失抛错**、嵌套对象替换、**C17/C18/C22 三项校验各自的成功与失败路径**。

**DoD**：⚠️ **M0 出口。人工复核第二部分全部契约后，才允许标记「冻结」。**

---

## M1 · Mock OA 环境

### T-04 · Mock 后端骨架

**依赖**：T-01

**交付**：`apps/mock-oa/backend/`
- Express + `express-session`（cookie name `MOCK_OA_SID`）
- `middleware/csrf.js`：生成 token 存 session，校验 `X-CSRF-TOKEN` 头
- `middleware/delay.js`：`/api/*` 随机延迟 300–800ms（K10），`?_nodelay=1` 可关
- 路由：
  - `POST /api/login` → 任意非空即成功，种 session
  - `GET  /api/session` → `{ loggedIn, user? }`
  - `GET  /api/userinfo` → `{ sub, preferred_username }`（供 identityProbe）
  - `GET  /api/csrf` → `{ token }`
  - `POST /api/_debug/expire` → 销毁 session（K12）
  - `GET  /api/_debug/forbidden` → 登录后固定返回 403（**不销毁 session**，用于测 C13）
  - 未登录访问 `/api/*`（除 login/session/csrf）→ 401

**验收**：
```bash
curl -s localhost:3000/api/session                    # {"loggedIn":false}
curl -si localhost:3000/api/overtime/types | head -1  # HTTP/1.1 401
```

---

### T-05 · Mock 业务接口 + 依赖陷阱 + 响应丢失场景

**依赖**：T-04

**交付**：
- `GET  /api/overtime/types` → `[{value:'workday',label:'工作日加班'},{value:'weekend',label:'周末加班'},{value:'holiday',label:'节假日加班'}]`
- `POST /api/overtime/approver` `{type}` → `{approverId, approverName, approvalToken}`
  - `approverId` 按 type 映射
  - **`approvalToken` 每次调用动态生成**，绑定 session + type + approverId，短期有效，提交后消费
- `POST /api/overtime/submit` → 校验 csrf + approverId 与 type 匹配 + **approvalToken 必须是本次流程 approver 接口生成的有效动态值** → `{code:0, no:'OT-YYYYMMDD-NNNN'}`
- `GET  /api/overtime/history?limit=&order=desc` → **返回本 session 真实创建的申请**（字段：`no/type/startTime/endTime/reason/createdAt`）。与 K9 虚拟滚动用的 200 条假数据分开
- `GET  /api/leave/types`、`POST /api/leave/balance`、`POST /api/leave/submit`（同构）
- `GET  /api/_debug/submissions` → 当前 session 已创建数量，**仅测试断言用**
- `POST /api/overtime/submit?drop_response=1` → **先真实创建并消费 token，再断开 socket 不返回响应**

**实现要点**：
- `approvalToken` 是**故意的依赖陷阱**：若分析器把录制时的值硬编码进 YAML，或跳过 approver 直接 submit，回放必然失败
- **依赖验证不能只用「同样的 workday 再放一次」**，必须有一条测试把 `type=workday` 改成 `weekend`，证明回放会重新调 approver

**❌ 禁止**：
- `postcondition` 不得引用 `/api/_debug/submissions`——它是测试专用，内网无对应物。postcondition 必须走 `history` 这类真实业务查询

**验收**：
```bash
# 1) 错误 approverId 必须失败
# 2) 缺失/复用旧 approvalToken 必须失败
# 3) 调 approver 拿新 token 后 submit 必须成功
# 4) 提交一条后 history 能查到
curl -s '.../api/overtime/history?limit=5' | grep '版本上线'
```

**DoD**：能稳定构造两类反例：① 跳过 approver → submit 必失败；② submit 已 commit 但响应丢失 → `_debug/submissions` 显示仅 1 条。

---

### T-06 · Mock Vue3 前端骨架 + 极简门户

**依赖**：T-04

**交付**：`apps/mock-oa/frontend/`
- Vue 3 + Element Plus + Vite + vue-router
- 页面：`Login.vue` `Portal.vue` `Home.vue` `LeaveApply.vue` `OvertimeApply.vue` `History.vue`
- **`Portal.vue`（新增）**：极简门户页，含一个指向 OA 的链接，文字为「OA办公系统」，点击后跳转 `/sso/redirect?token=<一次性>` 再落到 `/home`（供 T-56 验收 C19）
- `index.html` 注入 `<meta name="csrf-token" content="...">`（登录后前端写入）
- axios 封装：自动带 `X-CSRF-TOKEN`；401 跳登录页；**403 只显示「无权限」，不得跳登录页**

**验收**：`pnpm --filter mock-oa-frontend dev` 后手动登录可进门户，点链接可进 OA。

---

### T-07 · 复刻坑点 K1–K6、K10

**依赖**：T-05, T-06

**交付**：`OvertimeApply.vue`

| 坑 | 实现 |
|---|---|
| K1 | `el-select` 保持默认 `append-to-body`（**不要关掉**） |
| K2 | `el-date-picker` `type="datetime"` `:editable="false"` |
| K3 | 提交前弹 `el-dialog`，**保留默认 300ms 动画** |
| K5 | 提交按钮用 `<style module>` 的 class + `role="button"` + `@click` |
| K6 | `@change="loadApprover"` 调联动接口；`approverName` 只读展示，`approverId + approvalToken` 存页面内存随 submit 发送（token 不展示） |
| K10 | `loadApprover` 内 `await sleep(500)` |

`LeaveApply.vue` 同构（联动接口换 `balance`）。

**验收**：`pnpm --filter e2e test -g "K-points"`

断言：
- `document.querySelector('.el-select .el-select-dropdown__item')` 为 null
- 提交按钮 className 匹配 `/_submitBtn_\w+/`
- 选类型后 600ms 内 `/api/overtime/approver` 被调用
- submit body 含本次 approver 响应的 `approverId + approvalToken`；切换 type 后旧 token 失效

---

### T-08 · Vite 哈希每次 build 变化

**依赖**：T-06

**交付**：
```ts
// vite.config.ts
css: { modules: {
  generateScopedName: `[local]_${Math.random().toString(36).slice(2,8)}_[hash:base64:5]`
}}
```
外加 `scripts/verify-hash-changes.mjs`：连续 build 两次，比对 `submitBtn` class 名必须不同。

**验收**：`node apps/mock-oa/scripts/verify-hash-changes.mjs`（exit 0）

---

### T-09 · Legacy SSR 页面（+ Vue2 页面【条件启用】）

**依赖**：T-05

**交付 A（必做）**：`backend/routes/legacy.js`
- `GET /legacy/overtime` → SSR HTML，含 `__VIEWSTATE` 与 `__TOKEN` 隐藏字段
- `POST /legacy/overtime/submit` → form-urlencoded，校验两个隐藏字段，返回含「提交成功」的 HTML

**交付 B【条件启用，默认不做】**：`apps/mock-oa/frontend-vue2/`
Vue 2.7 + Element UI 2.15，仅一个加班申请页，接口复用。

> **启用条件**：内网执行 `dsh doctor --probe-frontend` 确认目标系统为 Vue2 + Element UI 后才做。

**验收**：`pnpm --filter e2e test -g "legacy"`（B 启用时另加 `-g "vue2"`）

---

### T-10 · 反向验证：朴素选择器必须失败

**依赖**：T-07, T-08

**交付**：`e2e/naive-selector.spec.ts`

```ts
test('朴素 CSS 选择器必须失败（否则 mock 不合格）', async ({ page }) => {
  await login(page);
  await page.goto('/overtime/apply');
  await expect(page.locator('.el-select .el-select-dropdown__item')).toHaveCount(0);
  const cls = await page.locator('[role=button]:has-text("提交")').getAttribute('class');
  expect(cls).toMatch(/_submitBtn_\w+/);
});
```

**验收**：`pnpm --filter e2e test -g "朴素"`

**DoD**：⚠️ **M1 出口。此测试通过 = mock 合格。若朴素选择器居然能成功，说明坑点没复刻到位，回头修 T-07，不得放行。**

---

## M2 · 定位器

### T-11 · 浏览器侧构建管线

**依赖**：T-02

**交付**：
- `packages/locator/build.mjs` —— esbuild 打 IIFE，输出 `dist/el-locator.iife.js`、`dist/recorder-probe.iife.js`、`dist/snapshot.iife.js`、`dist/selector-generator.iife.js`
- `packages/locator/src/_guard.ts` —— 构建时校验产物中不得出现 `require(`、`process.`、`import `

**❌ 禁止**：locator 包内不得 import 任何 npm 包（C9）。需要的常量值直接内联，或由构建时注入。

**验收**：
```bash
pnpm --filter @dsh/locator build
node -e "const s=require('fs').readFileSync('packages/locator/dist/el-locator.iife.js','utf8'); if(/require\(|process\./.test(s)) process.exit(1)"
```

---

### T-12 · el-locator 核心

**依赖**：T-11

**交付**：`packages/locator/src/el-locator.ts`，实现 §2.9 全部方法。

**关键实现（必须严格按此，这几处是踩过坑的）**：

```js
window.__DSH_LOCATOR__ = {

  version() {
    // Element Plus 有 .el-overlay / .el-config-provider；Element UI 有 .el-dialog__wrapper / .v-modal
    if (document.querySelector('.el-overlay, .el-config-provider')) return 'element-plus';
    if (document.querySelector('.el-dialog__wrapper, .v-modal')) return 'element-ui';
    return 'element-plus';
  },

  byFormItem(label, kind) {
    const norm = s => s.trim().replace(/[:：*\s]/g, '');
    const lbl = [...document.querySelectorAll('.el-form-item__label')]
      .find(l => norm(l.textContent) === norm(label));
    if (!lbl) throw new Error(`form-item not found: ${label}`);
    const item = lbl.closest('.el-form-item');
    const map = {
      input: '.el-input__inner', textarea: '.el-textarea__inner',
      select: '.el-select', datepicker: '.el-date-editor input',
      radio: '.el-radio', checkbox: '.el-checkbox'
    };
    const el = item.querySelector(map[kind] || map.input);
    if (!el) throw new Error(`control not found in ${label} (${kind})`);
    return el;
  },

  // ⚠️ 关键：面板 append-to-body，必须去 document 根上找
  async selectOption(label, optionText) {
    const sel = this.byFormItem(label, 'select');
    sel.click();
    const panel = await this.waitFor(() => {
      const ps = [...document.querySelectorAll('.el-select-dropdown')]
        .filter(p => p.style.display !== 'none'
                  && !p.classList.contains('el-select-dropdown--hidden'));
      return ps[ps.length - 1];
    }, 3000);
    const opt = [...panel.querySelectorAll('.el-select-dropdown__item')]
      .find(o => o.textContent.trim() === optionText);
    if (!opt) throw new Error(`option not found: ${optionText}`);
    opt.click();
    await this.sleep(120);
  },

  // ⚠️ 关键：不要操作日期面板，直接写值 + 触发响应式 + 回车确认
  async setDateTime(label, value) {
    const input = this.byFormItem(label, 'datepicker');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    await this.sleep(100);
    document.body.click();
  },

  // ⚠️ 关键：必须等 opacity===1 再等动画余量，否则点击被遮罩吞掉
  async inDialog(title, fn) {
    const dlg = await this.waitFor(() =>
      [...document.querySelectorAll('.el-dialog')]
        .find(d => d.querySelector('.el-dialog__title')?.textContent.trim() === title
                && getComputedStyle(d).opacity === '1'), 5000);
    await this.sleep(200);
    return fn(dlg);
  },

  tableRowButton(rowAnchorText, buttonText) {
    const row = [...document.querySelectorAll('.el-table__row')]
      .find(r => r.textContent.includes(rowAnchorText));
    if (!row) throw new Error(`row not found: ${rowAnchorText}`);
    const btn = [...row.querySelectorAll('button, .el-button, [role=button]')]
      .find(b => b.textContent.trim() === buttonText);
    if (!btn) throw new Error(`button not found in row: ${buttonText}`);
    return btn;
  },

  // ⚠️ 关键：全序列派发，绕过遮罩/动画/fixed 定位干扰
  robustClick(el) {
    el.scrollIntoView({ block: 'center' });
    const o = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  },

  setInputValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  },

  async resolve(strategy) { /* LocatorStrategy 联合类型分发器 */ },

  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async waitFor(fn, timeout = 5000, interval = 80) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await this.sleep(interval);
    }
    throw new Error('waitFor timeout');
  }
};
```

**❌ 禁止**：
- 不要用 `page.click()` 的坐标点击代替 `robustClick`
- 不要试图操作 date-picker 的日期面板
- 不要在 `.el-select` 内部找 option

**验收**：`pnpm --filter e2e test -g "el-locator"`，每个方法在 Vue3 mock 页上单独调通。

---

### T-13 · Element UI 2.x 兼容层【条件启用】

**依赖**：T-12, T-09B

> **状态：条件启用。** 默认不做。内网 `--probe-frontend` 确认为 Vue2 + Element UI 后才启用。

**交付**：`packages/locator/src/compat.ts` —— 类名映射表、`el-dialog` 结构差异、`version()` 探测后自动切换。

**验收**：`pnpm --filter e2e test -g "el-locator vue2"`

---

### T-14 · 手写脚本跑通加班流程

**依赖**：T-12

**交付**：`e2e/manual-overtime.spec.ts` —— 用 `page.evaluate` 直接调 `__DSH_LOCATOR__`：登录 → 进加班页 → 选类型 → 填时间 → 填事由 → 提交 → 确认弹窗 → 断言成功。

**验收**：
```bash
pnpm --filter e2e test -g "manual-overtime" --repeat-each=20
```

**DoD**：⚠️ **M2 出口。20 次连续通过。达不到不得进入 M3——定位器不稳，后面全白搭。**

---

### T-15 · 选择器生成器

**依赖**：T-12

**交付**：`packages/locator/src/selector-generator.ts` → `window.__DSH_GEN__(el)`

**优先级（从高到低，必须按此顺序）**：
1. `.el-select-dropdown__item` → `el-option`
2. 在 `.el-dialog` 内 → `el-dialog-scoped`（递归生成 inner）
3. 在 `.el-table__row` 内 → `el-table-cell`（`pickRowAnchor` 取该行最长的非空文本单元格）
4. 在 `.el-form-item` 内 → `el-form-item`
5. 有 `role` + 可见文本 → `role`
6. 有稳定文本 → `text`
7. 兜底 → `css`（**必须打日志警告**）

**❌ 禁止**：生成含哈希 class 的 css 选择器（匹配 `/_\w+_\w{5,}/` 或 `/^data-v-/` 的一律不用）。

**验收**：`pnpm --filter e2e test -g "selector-generator"`
断言：对 mock 页 12 个典型元素，**生成的策略没有一个是 `css`**。

---

### T-16 · 压缩快照生成器

**依赖**：T-12

**交付**：`packages/locator/src/snapshot.ts` → `window.__DSH_SNAPSHOT__()`

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
- 剔除不可见元素（`offsetParent === null` 或 `visibility:hidden`）与纯布局 div
- 单个文本截断 60 字符
- **总长度上限 8000 字符**，超出时优先保留可交互元素

**验收**：`pnpm --filter e2e test -g "snapshot"`
断言：加班页快照 < 2000 token（`Math.ceil(len/2.5)` 粗估），且含全部 6 个可交互元素。

---

## M3 · 浏览器载体与认证

### T-17 · Playwright 持久化上下文封装

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

/** 【必须实现】等待 URL 稳定，用于 SSO 多跳跳转后 */
export async function settleNavigation(page: Page): Promise<void>;
```

`settleNavigation` 规格：轮询当前 URL，连续 `TIMEOUTS.navigationSettle`(1.5s) 不变即认为跳转结束；总等待上限 `TIMEOUTS.navigationSettleMax`(30s)。

**要点**：
- 默认 `channel: 'chrome'`、`headless: false`
- `authServerAllowlist` 存在时追加 `--auth-server-allowlist=` 与 `--auth-negotiate-delegate-allowlist=`
- **必须 `addInitScript` 注入四个 IIFE 产物**

**❌ 禁止**：
- 导航后**不得立即** `page.evaluate`，必须先 `await settleNavigation(page)`。SSO 多跳期间会抛 `Execution context destroyed`（实测踩过）

**验收**：`pnpm --filter @dsh/browser test`，断言新页面上 `window.__DSH_LOCATOR__` 与 `__DSH_SNAPSHOT__` 存在。

---

### T-18 · 认证状态探测（四态）

**依赖**：T-17

**交付**：`packages/browser/src/auth.ts` → `getAuthState(page, entry): Promise<AuthState>`

**判定优先级（严格按序）**：
```
1. entry.sessionProbe 存在 → 页面内 fetch：
   - 401 → unauthenticated
   - 403 → forbidden          ← 【C13】禁止当成掉登录
   - 2xx 且配了 jsonPath → 按该路径布尔值判断
   - 2xx 但返回内容命中 loginDomMarkers（疑似登录 HTML）→ unauthenticated
   - 无法可靠判断 → unknown
2. 无 sessionProbe → 当前 URL 命中任一 loginUrlPatterns → unauthenticated
3. URL 不命中但 DOM 命中 loginDomMarkers → unauthenticated
4. 其他无法证明已登录的情况 → unknown（不得乐观当 authenticated）
```

**❌ 禁止**：代码中不得出现 `if (401 || 403)` 这类合并判断（C13）。

**验收**：`pnpm --filter e2e test -g "auth-state"`，覆盖四态：已登录 / 未登录 / 已登录但 403 / sessionProbe 返回 200 登录 HTML。

---

### T-19 · 登录握手

**依赖**：T-18

**交付**：`packages/browser/src/auth.ts` → `ensureLoggedIn(page, entry): Promise<void>`

```
authenticated   → 直接返回
forbidden       → 立即抛 ForbiddenError，【不弹登录横幅、不轮询】
unauthenticated → page.bringToFront() → 注入蓝色横幅 #__dsh_login_hint__ → 轮询
unknown         → 允许刷新 probeUrl 重探一次；仍 unknown 则报错，不无限等待
超时            → 抛 LoginTimeoutError
```

横幅内容：「DSH 需要认证：请在本窗口完成登录，成功后将自动继续」

**❌ 禁止**：
- **不得填写任何账号密码字段**（C16/C17）。这个函数只负责等待用户自己完成登录
- 不得在 403 时进入登录流程

**验收**：`pnpm --filter e2e test -g "ensureLoggedIn"`
- 调 `/api/_debug/expire` → `ensureLoggedIn` → 脚本模拟用户登录 → 正常返回，横幅已移除
- 403 时函数立即失败且**不出现登录横幅**

---

### T-20 · 认证恢复信号（不重放业务动作）

**依赖**：T-19

**交付**：
```ts
export async function recoverAuthentication(page: Page, entry: Entry): Promise<void>;
export function classifyAuthFromResponse(status: number, url: string, entry: Entry): AuthState | null;
```

规则：
- 401 或明确跳转登录页 → `unauthenticated`，调 `ensureLoggedIn`
- 403 → `forbidden`，**禁止触发重新登录循环**
- 本任务**不得接收 `fn` 参数并自动重跑**

**❌ 禁止**：
- ⚠️ **代码库中不得存在 `withSessionRecovery(page, auth, fn)` 这类会自动重跑 fn 的封装**（C14）。这会把写请求重复执行

**验收**：`pnpm --filter e2e test -g "session-recovery"`
- safe GET 会话过期后：检测 → 握手 → **由测试显式重试** → 成功
- 403 不进入握手
- 断言 `recoverAuthentication` 本身没有执行任何业务 POST

---

### T-21 · CDP 会话封装

**依赖**：T-17

**交付**：`packages/browser/src/cdp.ts` —— `attachCDP(page)`，暴露 `Network.enable`、`Fetch.enable` 薄封装。

**验收**：单测能拿到一条请求的 response body。

---

### T-56 · Entry 载体：门户跳转与会话建立

**依赖**：T-17, T-19

**交付**：`packages/browser/src/entry.ts`

```ts
export async function ensureEntry(page: Page, entry: Entry): Promise<{
  authState: AuthState;
  identityDigest: string;
  reused: boolean;
}>;
```

**流程（严格按序）**：
```
1. 执行 entry.sessionProbe
   ├─ 有效 且 当前 URL 命中 landingUrlPattern → reused=true，直接返回
   └─ 无效 → 继续

2. via === 'direct'
   → goto directUrl → await settleNavigation() → 等 landingUrlPattern

   via === 'portal'
   → goto portalUrl → await settleNavigation()
   → 探测门户会话
   │    ├─ 门户未登录 → 注入横幅「请完成门户认证」→ 轮询等待
   │    └─ 已登录 → 继续
   → 用 linkText 定位子系统入口链接并点击
   → 【C19】等待期间 URL 若命中 excludeUrlPatterns，
       只等待通过，不记录、不作为技能步骤
   → await settleNavigation() → 等 landingUrlPattern

3. 再次 sessionProbe 确认会话已建立
4. 执行 identityProbe，返回 identityDigest（对取到的标识做 sha256 摘要）
```

**❌ 禁止**：
- ⚠️ **`ensureEntry` 内部不得出现任何表单填写、密码输入、token 请求**（C16/C17）
- 「点击门户入口链接」是**导航**不是登录，日志与文档中都要如此表述

**验收**：`pnpm --filter e2e test -g "ensureEntry"`

| 场景 | 期望 |
|---|---|
| 会话已存在 | `reused=true`，不重走门户 |
| 会话失效 | 重走门户跳转并重建 |
| 门户未登录 | 弹横幅等待，用户登录后继续 |
| 一次性跳转 URL | 被跳过，不进入技能 |

**DoD**：grep `entry.ts`，不得出现 `password`、`fill(`、`grant_type` 等字样。

---

### T-57 · sessionType 探测与 Bearer 就地取用

**依赖**：T-56, T-21

**交付**：`packages/browser/src/probe-session.ts`、`packages/browser/src/bearer.ts`

**探测逻辑**：
```
1. 触发一次页面自身的无害请求（bearerSource.triggerUrl，或刷新当前页）
2. 用 CDP 观察该请求的头
   ├─ 只有 Cookie，无 Authorization → cookie
   ├─ 有 Authorization              → bearer，继续定位来源
   └─ 两者都有                      → mixed
3. bearer 时按序尝试定位：storage → global → cdp-inherit → ui-only
4. 产出 channelCapability：
   cookie / bearer(storage|global|cdp-inherit) → network: true
   bearer(ui-only)                             → network: false
```

**取用实现**：
```ts
export async function getLiveAuthHeader(page: Page, src: BearerSource): Promise<string | null> {
  switch (src.strategy) {
    case 'storage':
      return page.evaluate((keyPattern) => {
        const re = new RegExp(keyPattern, 'i');
        for (const store of [sessionStorage, localStorage]) {
          for (const k of Object.keys(store)) {
            if (!re.test(k)) continue;
            const raw = store.getItem(k);
            if (!raw) continue;
            try {
              const v = JSON.parse(raw);
              const t = v?.access_token ?? v?.token ?? v?.accessToken;
              if (t) return `Bearer ${t}`;
            } catch {
              if (/^ey[A-Za-z0-9_-]+\./.test(raw)) return `Bearer ${raw}`;
            }
          }
        }
        return null;
      }, src.key ?? 'token|auth|kc-');

    case 'global':
      return page.evaluate((path) => {
        const t = path.split('.').reduce<any>((o, k) => o?.[k], window);
        return t ? `Bearer ${t}` : null;
      }, src.globalPath!);

    case 'cdp-inherit':
      return captureAuthHeaderViaCDP(page, src.triggerUrl!);

    case 'ui-only':
      return null;
  }
}
```

**❌ 禁止**：
- ⚠️ **绝不通过登录接口换取新 token**（C17）。取的是用户登录已经产生的那一个
- token **只存在于本次回放的 Node 进程内存**，不落盘、不进诊断包
- **不得缓存 token**，每个 network 步骤执行前重新取一次（token 可能已刷新）

**验收**：
- Mock（Cookie 会话）→ 判定 `cookie`，`network: true`
- Keycloak 管理台 → 判定 `bearer` + `global`（`keycloak.token`）或 `ui-only`
- **注入 grep 测试**：取到的 token 不得出现在任何落盘文件中

---

### T-58 · `dsh doctor`

**依赖**：T-17, T-56, T-57

**交付**：`packages/cli/src/doctor.ts`

```bash
dsh doctor                                                    # 载体自检
dsh doctor --probe-entry --portal <url> --target <id>         # entry 探测
dsh doctor --probe-entry --direct <url>
dsh doctor --probe-frontend <url>                             # 前端框架探测
```

**载体自检输出**：
```
✓ Chrome 已安装        版本 138.0.7204.93
✓ 可启动 persistent context
✓ IIFE 注入成功
? 认证类型            需人工确认（A: Kerberos / B: 表单 / C: 证书）
✓ 代理配置            未设置
✗ remote-debugging    被企业策略禁用   ← 如出现此项需上报
```

**entry 探测输出**：
```
Entry 探测：oa（http://oa.corp.local）
────────────────────────────────────────
门户认证        ✓ 已登录
子系统入口      ✓ 找到链接「OA办公系统」
跳转链路        portal → /sso/redirect?token=*** → oa.corp.local/home
                ⚠ 检测到一次性认证跳转，已加入 excludeUrlPatterns
落地会话        Cookie: JSESSIONID           ✓
sessionType     cookie
通道能力        network ✓   ui ✓
身份标识        identityProbe 可用（$.sub）
────────────────────────────────────────
前端框架        Vue 2（依据 Vue.version=2.6.14）
组件库          element-ui（依据 .el-dialog__wrapper, .v-modal）
                → 需启用条件任务 T-09B / T-13
────────────────────────────────────────
已生成 entries/oa.yaml，请人工复核后使用
```

**前端探测脚本**：
```js
(() => {
  const r = { vue: null, ui: null, evidence: [] };
  if (window.__VUE__) { r.vue = 3; r.evidence.push('window.__VUE__'); }
  else if (window.Vue?.version) { r.vue = parseInt(window.Vue.version); r.evidence.push('Vue.version=' + window.Vue.version); }
  else if (document.querySelector('[data-v-app]')) { r.vue = 3; r.evidence.push('[data-v-app]'); }

  if (document.querySelector('.el-config-provider, .el-overlay')) { r.ui = 'element-plus'; r.evidence.push('.el-overlay'); }
  else if (document.querySelector('.el-dialog__wrapper, .v-modal')) { r.ui = 'element-ui'; r.evidence.push('.el-dialog__wrapper'); }
  return r;
})();
```

**DoD**：⚠️ **M3 出口。这是内网现场第一个要跑的命令，输出必须可直接贴给运维。每个目标系统各跑一次，结果决定该系统技能的通道能力。**

---

## M4 · 录制器

### T-23 · 录制探针

**依赖**：T-15

**交付**：`packages/locator/src/recorder-probe.ts`

```js
(function () {
  let openSelectLabel = null;
  function emit(a) { window.__DSH_RECORD__({ ...a, ts: Date.now() }); }

  document.addEventListener('click', e => {
    if (!window.__DSH_RECORDING__) return;
    const el = e.target;

    // ⚠️ 关键：select 面板在 body 上，openSelectLabel 需跨元素保持状态
    const selWrap = el.closest('.el-select');
    if (selWrap) {
      openSelectLabel = selWrap.closest('.el-form-item')
        ?.querySelector('.el-form-item__label')?.textContent.trim();
      return;                        // select 本身的点击不单独记录
    }
    const opt = el.closest('.el-select-dropdown__item');
    if (opt) {
      emit({ type: 'select', label: openSelectLabel, value: opt.textContent.trim() });
      openSelectLabel = null;
      return;
    }
    emit({ type: 'click', target: window.__DSH_GEN__(el), text: el.textContent.trim().slice(0, 30) });
  }, true);

  document.addEventListener('change', e => {
    if (!window.__DSH_RECORDING__) return;
    const el = e.target;
    if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
    if (el.closest('.el-date-editor'))
      emit({ type: 'datetime', target: window.__DSH_GEN__(el), value: el.value });
    else
      emit({ type: 'fill', target: window.__DSH_GEN__(el), value: el.value });
  }, true);
})();
```

**验收**：`pnpm --filter e2e test -g "recorder-probe"`
断言：手动完成加班流程后，action 序列为 `[navigate, select, datetime, datetime, fill, click, click]`。

---

### T-24 · 网络录制（双时间戳 + 落盘前脱敏）

**依赖**：T-17, T-02

**交付**：`packages/recorder/src/network.ts`

- `page.on('request')` → 创建记录，写 `requestTs`、`requestId`、method/url/resourceType/postData
- `page.on('response')` → 按 requestId 补 `responseTs`、status、responseBody
- `page.on('requestfailed')` → 补 `networkError`，`responseTs/status` 保持 null
- 用 `NOISE_PATTERNS` 过滤；非 xhr/fetch 的 GET 一律丢弃
- `mutating = method !== 'GET'`
- **headers/postData/responseBody/url 进入 RecordSession 前统一调 `sanitize.ts`，并把 content-type 传给 sanitizer（不得让它猜）**
- **URL 也要过 `sanitizeUrl`**（token 可能在 query）
- 记录 `sanitizeMode`

**❌ 禁止**：
- ⚠️ 后续 analyzer **只允许用 `requestTs` 做动作关联**，禁止用 `responseTs`（C15）
- 不得对 postData 整串正则脱敏（会破坏依赖识别）

**验收**：`pnpm --filter e2e test -g "network-record"`

断言：
- 加班流程保留请求数 ≤ 5，必含 `approver` 与 `submit`
- 每条正常请求 `requestTs <= responseTs`
- **人为慢响应不改变 `requestTs`**
- Authorization/Cookie/password/token 不出现在序列化后的 `record.json`
- **`approver` 与 `submit` 两条的 `sanitizeMode` 必须都是 `structured`**

**DoD**：若出现 `fallback`，说明解析逻辑没覆盖到，**必须修复而非放行**。

---

### T-25 · 录制会话编排

**依赖**：T-23, T-24, T-56

**交付**：`packages/recorder/src/session.ts`

```ts
export async function record(opts: {
  entryId: string; profileDir: string; outDir: string; startUrl?: string;
}): Promise<RecordSession>;
```

流程：`launchDSHContext` → **`ensureEntry`**（不是 ensureLoggedIn） → `exposeBinding('__DSH_RECORD__')` → 置 `__DSH_RECORDING__=true` → 注入红色录制条 → 等待用户操作 → 用户按 Enter 或关闭浏览器结束 → 写 `record.json`

**❌ 禁止**：
- ⚠️ **`__DSH_RECORDING__` 必须在 `ensureEntry` 完成之后才置 true**（C16）。登录/门户跳转过程绝不能被录进技能
- **命中 `entry.excludeUrlPatterns` 的导航一律不记录**（C19）

**验收**：`pnpm dsh record --entry oa --out ./tmp/rec1`

**DoD**：产出的 `record.json` 通过 `RecordSession` 类型校验；**其中不含任何登录页动作、不含一次性跳转 URL**。

---

### T-26 · `dsh record` CLI

**依赖**：T-25

**交付**：`packages/cli/src/record.ts`，参数：`--entry` `--out` `--profile` `--channel` `--start-url`

**验收**：`pnpm dsh record --help` 输出完整；实际录制产出文件。

---

### T-27 · `dsh diff` 双录对比

**依赖**：T-25

**交付**：`packages/cli/src/diff.ts`

对比两份 `record.json`：动作序列结构一致性、逐位置 value 对比、网络 body 逐字段对比。

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

### T-28 · 录制器端到端验证

**依赖**：T-26

**交付**：`e2e/record.spec.ts` —— 脚本化模拟用户操作，验证录制产物完整。

**DoD**：⚠️ **M4 出口。**

---

## M5 · 分析器

### T-29 · 动作-请求关联

**依赖**：T-25

**交付**：`packages/analyzer/src/correlate.ts` → `correlate(session): CorrelatedStep[]`

**规则**：
```
- 【C15】只使用 requestTs，禁止使用 responseTs
- 请求归给「最近的前置 action」，窗口边界：
  action[i].ts <= requestTs < min(action[i+1].ts, action[i].ts + 2000ms)
- 一个 action 可关联多个请求
- 不允许同一请求同时归属两个 action
- 无归属请求列为 orphan（页面加载初始化请求）
```

**同时交付弱值过滤规则**（供 T-30 使用）：
```
依赖识别的值过滤（按序判断，命中即跳过）：
1. 空值：null / undefined / '' / [] / {}
2. 布尔值：true / false / 'true' / 'false'
3. 短数字：整数且 |v| < DEPENDENCY.minNumberAbs (1000)
4. 弱值去重：某值在同一份 record 所有响应中出现次数 > DEPENDENCY.weakValueThreshold (3)
   ⚠️ 例外：fingerprint 形态（<REDACTED:sha256:...>）不适用本规则
5. 短字符串：长度 < DEPENDENCY.minStringLength (6) 且非 fingerprint 形态
```

**验收**：`pnpm --filter @dsh/analyzer test`

必须有的用例：
```ts
it('慢响应不改变归属', () => {
  // action A 发请求 A；500ms 后 action B；请求 A 在 800ms 才返回
  // 断言请求 A 仍归属 action A
});

it('大响应中的弱值不产生假依赖（Keycloak serverinfo 回归）', () => {
  // 含大量 true/false/0/1/"" 的大 JSON
  expect(deps).toHaveLength(0);
});

it('唯一 id 与 fingerprint 仍能识别', () => {
  // approverId:1023 与 approvalToken:<REDACTED:sha256:...>
  expect(deps).toHaveLength(2);
});
```

---

### T-30 · 副作用与依赖识别

**依赖**：T-29

**交付**：`packages/analyzer/src/correlate.ts`（续）

- `hasSideEffect`：该 action 关联了 mutating 请求
- **依赖识别**：遍历请求 B 的 body 所有叶子值，若某值出现在请求 A 的 responseBody 中（JSON 深度搜索，先过 T-29 弱值过滤），记 `B.dependsOn.push({ from, path, to })`。敏感动态值用 fingerprint 等值关联
- **加班场景必须同时识别**：
  - `submit.body.approverId <- approver.$.approverId`
  - `submit.body.approvalToken <- approver.$.approvalToken`
- 终态识别：最后一个 mutating 请求标记 `isSubmit`

**验收**：
```
0. 前置断言：参与依赖识别的两条请求 sanitizeMode 必须均为 'structured'。
   若为 'fallback' 直接判定不通过。
1. 单测：submit.dependsOn 同时含 approverId 与 approvalToken
2. 端到端反例：录制 workday，生成 draft 后回放时把参数改成 weekend。
   若回放未重新执行 approver 并注入新值，Mock submit 必须拒绝；
   正确实现必须成功。
```

**DoD**：⚠️ **M5 最关键的一条。不能仅靠「原参数原样回放成功」证明依赖识别正确。**

---

### T-31 · 参数候选标注

**依赖**：T-29

**交付**：`packages/analyzer/src/params.ts`

启发式（不用 LLM）：
- 用户 `fill`/`select`/`datetime` 输入过的值 → 高置信度参数
- 日期格式值 → 参数，type=datetime
- select 的值 → type=enum，values 从页面可选项收集
- **排除**：token/viewstate/csrf/session/timestamp 类字段名（正则黑名单）
- 有第二份录制时用 diff 提升置信度

**验收**：单测断言从加班录制识别出 4 个参数，且不含 csrf。

---

### T-32 · preflight 与 entry 检测

**依赖**：T-29

**交付**：`packages/analyzer/src/preflight.ts`

- headers 中发现 `X-CSRF-TOKEN`/`X-XSRF-TOKEN`/`__RequestVerificationToken` → 生成 PreflightSchema
  - 页面 meta 场景：无 request + `extract:{type:'dom', selector:'meta[name=csrf-token]', attribute:'content'}`
- form body 中发现 `__VIEWSTATE`/`__EVENTVALIDATION` → 生成 `request:{method:'GET', url:表单页}` + `extract:{type:'dom', selector:'input[name="__VIEWSTATE"]', attribute:'value'}`
- JSON token 接口 → `request GET` + `extract.type='jsonPath'`
- 扫描 401 与登录跳转 → 建议 `entry.loginUrlPatterns`；**403 只标注 forbidden，不得写成 login pattern**
- 发现 `/api/session`、`/api/user/current` 类请求 → 建议 `entry.sessionProbe`
- **【C19】识别一次性认证跳转**（URL 含 `?token=`/`?ticket=`/`/sso/callback`），从步骤中剔除，并在 draft 写警告：
  ```yaml
  # 检测到一次性认证跳转，已排除。
  # 回放前请确保 profile 中已有有效会话（见 entries/<id>.yaml）。
  ```

**验收**：单测覆盖 Vue3 meta csrf / Legacy `__VIEWSTATE` / JSON token / 401 登录过期 / **403 不被误判** / **一次性跳转被剔除**。

---

### T-33 · draft.yaml 生成器

**依赖**：T-30, T-31, T-32

**交付**：`packages/analyzer/src/draft.ts`

- 输出严格符合 `SkillSchema`
- **channel 判定**：有关联 mutating 请求 → `network`（同时填 `ui` 降级）；无关联请求的 fill/datetime → `merged`；只有导航 → `network`(GET)
- **`idempotent` 推导**：read 类 → true；write/critical → false
- **`reentry.anchor` 推导**：取第一个非幂等步骤之前的那一步
- **依赖值必须生成跨步模板引用**（`approverId: '{{s2.approverId}}'`），**不得把录制时动态值硬编码**
- **postcondition 草稿**：若录制中出现「提交后跳转列表页 / 调了历史查询接口」，把该 GET 作为候选；`match.where` 用参数化字段自动填充；整段打 `# TODO`
- 若无法推断 postcondition，写入：
  ```yaml
  # TODO: 未能自动推断 postcondition。
  # 缺少 postcondition 时，一旦提交响应丢失，回放将直接中止并要求人工判断。
  # 强烈建议手工补一个幂等的 GET 查询。
  # postcondition:
  #   request: { method: GET, url: /api/overtime/history?limit=5 }
  #   match: { jsonPath: "$.list[*]", where: { reason: "{{reason}}" } }
  #   expectFound: true
  ```
- 所有推断项加 `# TODO`（用 `yaml` 库的 comment API，**不要字符串拼接**）
- `_notes` 写清判断依据
- `riskLevel`：POST/PUT/DELETE → `write`；url 含 approve/delete/pay → `critical`

**❌ 禁止**：
- 生成的技能中**不得含 auth 段**（已上移到 entry）
- 不得把登录步骤写入 steps（C16）

**验收**：
```bash
pnpm dsh analyze ./tmp/rec1 --out ./skills/oa_overtime_submit.draft.yaml
```
产物必须通过 `parseSkill()` 校验，`# TODO` 数量 ≥ 3。

---

### T-34 · `dsh analyze` CLI

**依赖**：T-33

**交付**：`packages/cli/src/analyze.ts`，支持 `--compare <rec2>` 启用 diff 增强、`--llm` 启用 T-46 标注。

**DoD**：⚠️ **M5 出口。**

---

## M6 · 回放器

### T-35 · 回放引擎骨架

**依赖**：T-03, T-17, T-56

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

流程：`launchDSHContext` → **`ensureEntry`** → 记录 `identityDigest` → 执行 preflight → 逐步执行 → 断言 → 返回 `RunResult`

**验收**：`--dry-run` 能打印完整执行计划而不实际操作。

---

### T-36 · preflight 执行器

**依赖**：T-35

**交付**：`packages/replayer/src/preflight.ts`

按 `PreflightSchema` 四种组合执行：
1. 无 request + dom → 当前页面 DOM 提取
2. 有 request + jsonPath → 页面内 GET/POST → JSONPath
3. 有 request + dom → 页面内 GET/POST → 得到 HTML → `DOMParser` → selector + attribute（ASP.NET `__VIEWSTATE`）
4. 有 request + regex → 响应文本 regex 提取

结果写 `ctx.vars`。所有请求遵守 C2。

**❌ 禁止**：提取到的 token/ViewState **只存运行时内存**，真实值不得进诊断/日志。

**验收**：`ctx.vars.csrf` 非空；Legacy 页能提取 `__VIEWSTATE`；JSON token 场景可提取；**诊断信息中看不到真实值**。

---

### T-37 · network 通道执行器 + Outcome 分类

**依赖**：T-35, T-57

**交付**：`packages/replayer/src/channel-network.ts`

**必须严格按 C2**：在 `page.evaluate` 内用 `fetch` + `credentials:'include'`

**执行前的会话类型分流（C18）**：
```
读取 entry.sessionType
├─ cookie      → 直接 fetch，credentials:'include'
├─ bearer/mixed → 调 getLiveAuthHeader()
│    ├─ 取到 → 注入 Authorization 头后 fetch
│    └─ 取不到 → 抛 BearerUnavailableError，outcome=not_sent，可安全降级 ui
└─ unknown     → 抛错，要求先跑 dsh doctor --probe-entry
```

**Outcome 判定（机械规则，不做异常类型推测）**：
```
┌─ 阶段 1：fetch 调用之前 ─────────────────────┐
│  模板变量解析失败 / 参数校验失败                │
│  preflight 未取到必需变量                      │
│  getLiveAuthHeader 返回 null                  │
│  onConfirm 返回 false                         │
│  → 一律 not_sent                              │
└──────────────────────────────────────────────┘
                ↓ 进入 fetch()
┌─ 阶段 2：fetch 已调用 ───────────────────────┐
│  ⚠️ 从这一行开始，任何异常一律 outcome_unknown  │
│  收到响应：                                    │
│    2xx + 断言通过           → confirmed_success│
│    4xx/5xx 且响应体明确表明   → confirmed_failure│
│      未产生副作用（如 400 参数校验失败）         │
│    4xx/5xx 但无法判断         → outcome_unknown │
│  未收到响应（catch）：                          │
│    任何异常类型              → outcome_unknown  │
│    （不区分 TypeError/AbortError/超时）         │
└──────────────────────────────────────────────┘
```

实现用显式标志位：
```ts
const result = await page.evaluate(async (req) => {
  let fetchStarted = false;
  try {
    fetchStarted = true;              // ← 就在 fetch 前一行置位
    const res = await fetch(req.url, { credentials: 'include', /* ... */ });
    return { fetchStarted, status: res.status, text: await res.text() };
  } catch (e) {
    return { fetchStarted, error: String(e), status: null, text: null };
  }
}, resolved);

if (!result.fetchStarted) return outcome('not_sent');
if (result.status === null) return outcome('outcome_unknown');   // 无条件
```

**❌ 禁止**：
- ⚠️ **不得试图从异常类型区分「请求发没发出去」**。`TypeError: Failed to fetch` 涵盖 DNS 失败、连接拒绝、响应丢失，无法区分，猜错即重复提交
- **不得把所有 catch 映射成 `confirmed_failure`**
- **不得用 Node 侧 http 客户端**（C2）

**验收**：`pnpm --filter e2e test -g "channel-network"`
- 正常完成加班提交，`approverId + approvalToken` 来自 s2
- 模板缺失 → `not_sent`
- `drop_response=1` → `outcome_unknown`，且服务端 submissions 已增加 1

---

### T-38 · ui 通道执行器

**依赖**：T-35, T-12

**交付**：`packages/replayer/src/channel-ui.ts`

- action 分发到 `__DSH_LOCATOR__`
- `label` + `kind` 快捷写法转 `el-form-item` 策略
- `preAction` 先执行；`waitFor` 条件等待
- 失败抛 `LocatorNotFoundError`（带 stepId 与策略详情）

**验收**：`--force-channel ui` 能完成加班提交。

---

### T-39 · merged 通道 + 安全降级链

**依赖**：T-37, T-38, T-20

**交付**：`packages/replayer/src/engine.ts`（续）

```
merged → 只把值写入 ctx.vars，不执行

auto / network+ui fallback → 只有满足安全重试条件才允许降级：
  1. outcome === not_sent；或
  2. outcome === confirmed_failure 且可证明目标副作用未发生

outcome_unknown 处理（严格按序，不得跳步）：
  1. 禁止任何自动 UI fallback / network retry
  2. 解析 postcondition：step.postcondition → skill.postcondition
     ├─ 不存在 → 抛 OutcomeUnknownError + 诊断包 + 中止
     └─ 存在 → 继续
  3. 执行 postcondition（页面上下文内 GET，遵守 C2）
     ├─ 请求本身失败 → 抛 OutcomeUnknownError + 中止
     └─ 成功 → 继续
  4. 按 match.jsonPath 取候选集，按 match.where（模板解析后）逐项匹配
     ├─ 命中 && expectFound=true   → 改写 confirmed_success，继续
     ├─ 未命中 && expectFound=true → 改写 confirmed_failure，
     │                                此时才允许按安全规则降级
     └─ 其余组合按 expectFound 语义对称处理
  5. 无论哪条分支，都在 StepResult 记录
     { outcomeResolvedBy:'postcondition', postconditionResult }
     并写入诊断包

会话失效 → 交给 T-59 重入引擎处理（本任务不自行重放）

write/critical 步骤执行前调 onConfirm；
认证恢复、自愈后不得复用旧确认绕过新的高风险动作
```

**❌ 禁止**：
- ⚠️ **「请求异常 = 自动再点一次」视为失败实现**

**验收**：`pnpm --filter e2e test -g "fallback"`

至少三条：
1. s5 URL 改成发送前即可确认无副作用的错误 → 允许降级 UI 并成功
2. `drop_response=1` → **禁止 UI fallback**，`_debug/submissions` 最终只有 1 条
3. 403 → 报 forbidden，不触发登录循环、不触发业务重试

---

### T-40 · 断言引擎

**依赖**：T-35

**交付**：`packages/replayer/src/assert.ts`，支持 `httpStatus`/`jsonPath`/`textPresent`/`regexExtract`，失败抛 `AssertionFailedError`。

**验收**：单测覆盖 4 种类型的成功与失败路径。

---

### T-41 · 诊断包

**依赖**：T-35, T-02

**交付**：`packages/replayer/src/diagnostic.ts`

失败时在 `runs/<ISO时间戳>/` 产出：
`result.json` / `step-<id>-before.png` / `step-<id>-after.png` / `step-<id>-dom.html` / `step-<id>-snapshot.txt` / `network.har` / `console.log` / `llm-trace.jsonl`（若有）

**硬要求**：
- `result.json`、HAR、DOM、console、LLM trace 写盘前**统一经 `sanitize.ts`**
- ⚠️ **`StepResult.raw.text` 不得直接调 `sanitizeText`，必须调 `sanitizeBody(text, contentTypeHint)`**（走结构化路径，防双层转义泄漏——这是实测踩过的）
- HAR 中 Authorization/Cookie/Set-Cookie 不得出现真实值
- 截图无法可靠结构化脱敏，Mock 验收页面不得放真实敏感数据；生产阶段另做策略，**不得声称已自动完成像素级脱敏**

**验收**：
- 故意破坏一步，断言 8 类文件齐全
- 向 mock 注入测试 Authorization/Cookie/password/token，**递归 grep `runs/` 不得找到原始秘密值**

---

### T-59 · 重入引擎

**依赖**：T-39, T-56

**交付**：`packages/replayer/src/reentry.ts`

**流程（严格按序）**：
```
任一步骤检测到会话失效（401 / 跳转登录页）
  ↓
1. 记录 interruptedStepId 与其 ExecutionOutcome
  ↓
2. recoverAuthentication()        ← 只恢复认证，不重放业务（C14）
  ↓
3. 【C21】身份校验
   执行 entry.identityProbe，与 ctx.identityDigest 比对
   ├─ 不一致 → 抛 IdentityChangedError + 诊断包 + 中止
   │            日志写明「旧身份摘要 X → 新身份摘要 Y，拒绝继续」
   └─ 一致 → 继续
  ↓
4. 重入次数检查：已达 reentry.maxReentries → 中止
  ↓
5. 按中断位置分流
   ├─ 中断步骤 idempotent=true
   │    → 从 reentry.anchor 重跑（C22）
   └─ 中断步骤 idempotent=false（写操作）
        → outcome 必为 outcome_unknown
        → 走 T-39 的 postcondition 流程：
             ├─ 确认已成功 → 标记 confirmed_success，跳过该步，从下一步继续
             ├─ 确认未成功 → 从 anchor 重跑
             └─ 无法确认   → 抛 OutcomeUnknownError + 中止
  ↓
6. 重跑时必须重新执行 ensureEntry（会话已变，需重建子系统会话）
   并重跑 preflight（csrf/ViewState 在新会话中已变）
   清空 anchor 之后所有 ctx.stepResults 与派生的 ctx.vars
```

**❌ 禁止**：
- ⚠️ **不得实现「记录断点 stepId 然后从那继续」**（C22）。页面状态在重新登录后已丢失，表单值、弹窗态、联动结果全部不在了
- **不得跳过身份校验**（C21）
- 诊断包中身份**只记摘要，不记原值**

**验收**：`pnpm --filter e2e test -g "reentry"`

| 场景 | 期望 |
|---|---|
| s2（幂等）时会话过期 → 恢复 → 从 anchor 重跑 | 成功，submissions == 1 |
| s5（写）时会话过期 → 恢复 → postcondition 查到 | 跳过 s5，submissions == 1 |
| s5 时会话过期 → postcondition 查不到 → 从 anchor 重跑 | 成功，submissions == 1 |
| s5 时会话过期 → 无 postcondition | 中止，submissions == 1 |
| **恢复后换了身份** | **中止，不执行任何后续步骤** |
| 连续失效超过 maxReentries | 中止 |

**DoD**：⚠️ **六个场景中 `submissions` 最终数量全部为 1。任何一个为 2 视为实现失败。**

---

### T-42 · `dsh replay` CLI

**依赖**：T-39, T-40, T-41, T-59

**交付**：`packages/cli/src/replay.ts`
参数：`--params <json|file>` `--dry-run` `--channel ui|network` `--no-llm` `--profile` `--yes`（跳过确认，**仅测试用**）

**验收**：
```bash
pnpm dsh replay skills/oa_overtime_submit.yaml \
  --params '{"type":"工作日加班","startTime":"2026-08-18 18:00","endTime":"2026-08-18 21:00","reason":"版本上线"}' \
  --yes
```

**DoD**：⚠️ **M6 出口。A1–A5 必须通过，且所有安全场景 submissions 均为 1。**

---

## M7 · LLM 主脑

### T-43 · LLM Provider

**依赖**：T-02

**交付**：`packages/llm/src/provider.ts`

- `DeepSeekProvider implements ILLMProvider`，走 OpenAI 兼容端点
- 配置来自环境变量
- **`supportsVision` 恒为 `false`**（C3：任何代码不得依赖其为 true）
- 内置重试（网络错误 3 次指数退避）
- 每次调用写 `llm-trace.jsonl`：`{ts, purpose, model, messages, response, tokensEstimate, durationMs}`；**messages/response 落盘前必须经 `sanitize.ts`**

**验收**：`pnpm --filter @dsh/llm test`（用 mock server，不打真实 API）

---

### T-44 · JSON 输出护栏

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

**验收**：单测覆盖：一次成功 / 首次非法二次成功 / 三次全非法抛错。

---

### T-45 · J1 意图路由与参数抽取

**依赖**：T-44

**交付**：`packages/llm/src/route.ts`

```ts
export async function route(llm, userInput: string, skills: Skill[]):
  Promise<{ skillId: string | null; params: Record<string, any>; missing: string[] }>;
```
- 输入：用户自然语言 + 所有技能的 `{id, name, description, params}`
- 输出必须过参数 Schema 校验
- **enum 参数的值必须在 `values` 内，否则算 missing**
- **不允许 LLM 编造未提及的参数值**

**验收**：单测（mock LLM）覆盖：命中 / 无匹配 / 参数缺失 / enum 非法值。

---

### T-46 · J2 录制后标注

**依赖**：T-44, T-33

**交付**：`packages/llm/src/annotate.ts`

离线增强 draft：技能 id/name/description、每步 desc、参数命名与 prompt、断言建议、postcondition 建议、风险提示。

**❌ 禁止**：**所有 LLM 产出必须打 `# TODO`**，不得直接作为定稿。

**验收**：`pnpm dsh analyze ./tmp/rec1 --llm --out ...`，产物仍通过 `parseSkill()`。

---

### T-47 · J3 失败自愈：先 resolve-only

**依赖**：T-44, T-38, T-16

**交付**：`packages/llm/src/heal.ts`

```ts
export async function proposeHeal(ctx: {
  llm; page; step: Step; error: Error; snapshot: string
}): Promise<HealCandidate | null>;
```

流程：
```
1. 抓 __DSH_SNAPSHOT__()
2. 提问：原定位 + 失败原因 + 步骤目标 + 快照 + 允许的 strategy 列表
3. chatJSON 拿到新 LocatorStrategy
4. 【只做 resolve-only 验证】
   - 唯一匹配（不能 0 个/多个）
   - visible
   - enabled（若适用）
   - 元素类型与步骤 action 兼容
   - 关键文本/label/对话框上下文与目标语义一致
5. 生成 HealCandidate：resolveVerified=true, actionVerified=false,
   requiresConfirm = step.riskLevel !== 'read' || step.hasSideEffect
6. resolve 验证失败 → 最多 RETRY.healMax 次后返回 null
```

**❌ 禁止**：
- ⚠️ **不得在本任务里 click「提交/审批/删除/支付」来证明 locator 正确**（C4）。这会产生真实业务写入

**验收**：`pnpm --filter e2e test -g "heal-resolve"`
- 「事由」改成「加班原因」→ 能生成 resolveVerified candidate
- 提交按钮文案改掉 → 能生成 candidate，但 **submissions 数量保持 0**（证明 resolve 阶段没真提交）

---

### T-48 · 自愈执行、确认、postcondition 与写回

**依赖**：T-47, T-40

**交付**：`packages/llm/src/heal.ts`（续）+ `packages/core/src/skill-writer.ts`

```
1. 接收 HealCandidate
2. requiresConfirm=true → 必须重新走 onConfirm；用户拒绝则不执行、不写回
3. 真正执行修复后的动作
4. 对有副作用步骤执行 step/global postcondition/assertion
5. 只有动作成功且断言通过，才 candidate.actionVerified = true
6. 【仅 resolveVerified && actionVerified 时 commit】：
   - skill.version += 1
   - 更新 target
   - 追加 _healHistory
   - 用 yaml 库写回并保留注释
7. 任一步骤失败 → 丢弃 candidate，不修改正式 skill.yaml
```

**❌ 禁止**：未验证就写回（C4）。这会静默污染技能库，比直接失败更糟。

**验收**：
- read/fill 类自愈通过后能写回
- **write click 自愈必须先触发确认；拒绝时 YAML 完全不变**
- **postcondition 失败时 YAML 完全不变**
- 写回后文件仍可 `parseSkill()`，原 `# TODO` 注释还在

---

### T-49 · 【Stretch】J4 受限动作空间探索

**依赖**：T-44, T-16

> **状态：Stretch Goal。Core 验收不得因本任务未完成而失败。**

- 动作白名单：`selectOption` `fill` `setDateTime` `click` `waitFor` `readValue` `done` `fail`
- **三重校验**：zod action 白名单、`idx` 存在于当前快照、enum 值合法
- 任一不过 → 回灌错误重试，最多 `RETRY.llmSchemaMax`
- 步数上限 `RETRY.exploreMaxSteps`
- 每步执行后重新生成快照
- 有副作用动作仍需 `onConfirm`（C6）
- 写动作遵守 C12，不允许 `outcome_unknown` 后自动重复操作

---

### T-50 · 【Stretch】探索结果固化为技能

**依赖**：T-49

探索成功后，动作序列 + 期间捕获且已脱敏的网络请求 → 走 T-33 draft 逻辑 → 写 `skills/<id>.yaml`。固化前仍需 Schema 校验，**动态 token 不得硬编码**。

---

### T-51 · 主脑编排与 token 熔断

**依赖**：T-42, T-45, T-48
**可选依赖**：T-50（仅启用 Stretch 时）

**交付**：`packages/cli/src/run.ts` —— `dsh run "<自然语言>"`

**Core 流程**：
```
route → 命中 skill → replay → 定位失败时 proposeHeal
      → confirm/execute/assert → commit heal
```

**未命中 skill 时**：
- Core 默认：明确返回 `NO_MATCHING_SKILL`，提示需先录制技能
- 仅当检测到 Stretch T-49/T-50 已启用且配置允许，才进入 explore

其他：
- token 预算：单次任务超 `DSH_TOKEN_BUDGET`（默认 50000）熔断
- `--no-llm` 跳过全部 LLM 环节，仅确定性回放

**❌ 禁止**：无匹配技能时**不得偷偷进入开放式 Agent 循环**，必须可控失败。

**验收**：
```bash
pnpm dsh run "帮我提交明天晚上6点到9点的工作日加班，事由是版本上线"
```

**DoD**：⚠️ **M7 Core 出口。**

---

## M8 · 验收

### T-52 · 验收 A1–A5 + 安全专项

**依赖**：T-42

**交付**：`e2e/acceptance/a1-a5.spec.ts`

- **A1** 录制加班 → 产出 draft.yaml
- **A2** 修正后回放，`--repeat-each=10`，成功 ≥ 9
- **A3** 见 T-53
- **A4** 录制请假，复用同一录制器无需改代码
- **A5** network 通道单次 < 2 秒

**安全专项**：
```
S1-a 无 postcondition：drop_response=1 → 抛 OutcomeUnknownError 中止
                        → submissions == 1
S1-b 有 postcondition：drop_response=1 → 自动执行 postcondition 查到该条
                        → 改写 confirmed_success → 继续
                        → submissions == 1（关键：没有因「确认成功」再提交）
S1-c 查不到：构造提交前即失败的场景 + 人为断开响应
                        → postcondition 查不到 → 改写 confirmed_failure
                        → 允许安全降级重试 → submissions == 1
S2   认证专项：403 forbidden 不得触发登录循环或自动业务重试
```

**DoD**：⚠️ **三个子场景的 submissions 必须全部为 1。任何一个为 2 视为实现失败。**

---

### T-53 · A3 专项：build 后回放

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

**DoD**：⚠️ **这是整个 Demo 最核心的验收项。**

---

### T-54 · 验收 A6–A12

**依赖**：T-51

**交付**：`e2e/acceptance/a6-a12.spec.ts`

- **A6** 改按钮/label 文案 → LLM 自愈；5 种变更至少 4 种恢复；**写动作必须验证「resolve 阶段未执行、确认+断言后才写回」**
- **A7** Legacy SSR 页录制回放（必须真实走 HTML preflight 提取 `__VIEWSTATE`）
- **A8**【条件启用】Vue2 页录制回放；未启用时标记 skipped
- **A9** 自然语言 → 意图路由 → 参数抽取 → 已有技能执行
- **A10**【Stretch】无技能探索并固化；未实现时 skipped，**不计入 Core 失败**
- **A11** 会话过期 → 登录握手 → 按安全规则决定是否继续；403 单独验证 forbidden；**身份变更时中止**
- **A12** LLM 输出非法动作/非法 locator → 被 Schema/策略护栏拦截重试

**Core DoD**：A6/A7/A9/A11/A12 全绿。

---

### T-55 · 交付文档

**依赖**：T-53, T-54

**交付**：
- `README.md`：安装、启动 mock、entry 配置、录制、回放、run 全流程
- `docs/migration-checklist.md`：迁移清单 + 载体清单 + **现场必测项**（见附录 A）
- `docs/skill-authoring.md`：技能 YAML 手工编写与修正指南
- `docs/entry-authoring.md`：entry 配置指南，**明确说明「DSH 不代替用户登录」**
- `docs/troubleshooting.md`：诊断包怎么看；单列 `outcome_unknown`、403、登录恢复、身份变更、重复提交保护、脱敏规则

**验收**：新人按 README 从零跑通一次回放，全程无需询问。

---

### T-60 · 【预留】`dsh doctor --check-unattended`

**依赖**：T-58

> **状态：预留，低优先级，可延后。** 只做检查与告警，不实现无人值守执行能力。

```
无人值守可行性检查
────────────────────────────────────────
电源策略        ✓ 已设置为「从不休眠」
自动重启        ⚠ Windows 更新可能触发重启
浏览器进程      ✓ 存活
Keycloak Idle   ⚠ 30 分钟 ← 关键限制，非 Max 7 天
门户 token      ? 无法探测，需人工确认
预计可用窗口    ⚠ 约 30 分钟（受 Keycloak Idle 限制）
keepalive       ✗ 未启用（启用需安全部门书面同意）
────────────────────────────────────────
结论：当前配置下不支持夜间无人值守。
```

---

# 第四部分 · 依赖图

```
T-01 ─ T-02* ─ T-03* ──────────────────────────────┐
        │                                           │
        ├─ T-11 ─┬─ T-12 ─┬─ [T-13 条件]           │
        │        │        ├─ T-14*                  │
        │        │        ├─ T-15 ─ T-23            │
        │        │        └─ T-16 ────────┐         │
        │        │                        │         │
        │        └─ T-17 ─┬─ T-18 ─ T-19 ─┼─ T-20   │
        │                 ├─ T-21          │         │
        │                 ├─ T-56 ─┬─ T-57─┴─ T-58* │
        │                 │        └─────────┐      │
        │                 └─ T-24 ─ T-25 ─┬─ T-26 ─ T-28*
        │                                 └─ T-27   │
        │                                            │
        └─ T-43 ─ T-44 ─┬─ T-45 ──────────┐         │
                        ├─ T-46            │         │
                        └─ T-47 ─ T-48* ───┤         │
                                            │         │
                [Stretch] T-49 ─ T-50 ──────┤         │
                                            │         │
T-25 ─ T-29 ─┬─ T-30* ─┐                   │         │
             ├─ T-31 ──┼─ T-33 ─ T-34*     │         │
             └─ T-32 ──┘                    │         │
                                            │         │
T-03 + T-17 + T-56 ─ T-35 ─┬─ T-36         │         │
                            ├─ T-37 ─┐      │         │
                            ├─ T-38 ─┼─ T-39┼─ T-59   │
                            └─ T-41  │      │   │     │
                                     └─ T-40┴───┴─ T-42*
                                                     │
                                    T-42 + T-45 + T-48 ─ T-51* ─ T-54*
                                                                   │
T-52* ─ T-53* ─────────────────────────────────────────────────────┴─ T-55*

* = 停止检查点，不通过不得继续
```

**关键依赖说明**：
- `T-35` 依赖 `T-56`：回放必须先 `ensureEntry`
- `T-37` 依赖 `T-57`：network 通道需知道 sessionType
- `T-42` 依赖 `T-59`：replay CLI 需包含重入能力
- `T-51` 依赖 `T-42`：主脑流程包含 replay
- `T-55` 依赖 `T-53 + T-54`：交付不得绕过 rebuild 核心验收

---

# 第五部分 · 里程碑停止检查

**完成每个里程碑的最后一个任务后，必须停下等人工确认。**

| 里程碑 | 停止检查项 |
|---|---|
| **M0** | build/test/tsc 全绿；人工复核第二部分全部契约（`EntrySchema`、`ExecutionOutcome`、`AuthState`、`PreflightSchema`、`PostconditionSchema`、`ReentrySchema`、`RecordedRequest` 双时间戳、sanitizer）后才允许标记「冻结」 |
| **M1** | T-10 通过 = 朴素选择器**确实失败**；T-05 依赖陷阱证明「跳过 approver 或复用旧 approvalToken → submit 必失败」；history 能查到真实提交 |
| **M2** | T-14 连续 20 次通过。达不到不得往下走 |
| **M3** | `dsh doctor` 输出可直接发运维；认证四态测试全绿，403 不触发登录握手；sessionType 探测在 Mock 与 Keycloak 上各验证一次；**grep `entry.ts` 无 password/fill/grant_type** |
| **M4** | record.json 动作/网络完整；`sanitizeMode` 全为 structured；用测试 secret grep 文件不得泄漏；**record 中不含登录动作与一次性跳转** |
| **M5** | T-30 正确识别 `approverId + approvalToken` 跨请求依赖；**workday 录制 → weekend 回放仍成功**；draft 含 postcondition 或明确 TODO |
| **M6** | A1–A5 通过；`--no-llm` 主路径可跑；S1-a/b/c 三场景 **submissions 均为 1**；T-59 六个重入场景 **submissions 均为 1**；403 不重试业务 |
| **M7 Core** | A6 自愈 ≥ 4/5；**写动作 resolve 阶段 0 次副作用**；A9/A11/A12 全绿 |
| **M8** | T-53 rebuild 循环 5 次全通过 + T-54 Core 全绿 |

---

# 第六部分 · 坑位表

> **建议把第零、一、二部分和本节作为每个任务的固定上下文。以下均为硬约束。**

| 坑 | 表现 | 正确做法 |
|---|---|---|
| **用 password grant 换 token** | 违反 C8/C17，且否定整个架构的存在理由 | ⚠️ **实测踩过（§0.3）。** 借用用户已有会话；离线需求走服务账号申请 |
| **技能里包含登录步骤** | 逼出「自动登录」需求，滑向存储凭证 | C16：技能起点恒为「已通过 entry 进入」，登录归载体 |
| **假设 `credentials:'include'` 万能** | Bearer 内存态 SPA 上必然 401 | C18：先 `--probe-entry` 判定 sessionType，bearer 走就地取用或 ui 通道 |
| **重放一次性认证跳转 URL** | token 已消费，必然失败，可能触发风控 | C19：`excludeUrlPatterns` 整段排除 |
| select 面板不在 select 内 | `selectOption` 找不到选项 | 去 `document` 根找最后一个可见 `.el-select-dropdown` |
| 弹窗动画期间点击被吞 | 点了没反应 | `opacity===1` 后再等 `TIMEOUTS.dialogAnimation` |
| date-picker 直接 `fill` 无效 | Vue 不更新 model | 原生 setter + input/change + Enter |
| **network 步骤用 Node fetch** | Cookie 丢失、CORS/会话行为不一致 | **必须 `page.evaluate` 内 fetch**（C2） |
| 模板变量缺失静默变空串 | 请求参数错误但不报错 | 缺失必须抛错，结果视为 `not_sent` |
| **试图从异常类型区分「请求发没发出去」** | `TypeError: Failed to fetch` 涵盖 DNS 失败、连接拒绝、响应丢失，猜错即重复提交 | 用 `fetchStarted` 标志位，置位在 `fetch()` 调用**前一行**；置位后任何异常一律 `outcome_unknown` |
| `outcome_unknown` 自动 fallback | 重复创建单据、重复审批/删除 | 禁止自动重放；先 postcondition，无法确认就中止 |
| **Auth 层自动重跑 `fn`** | 登录恢复后把写请求再发一遍 | Auth 只恢复认证；Replay Engine 决定是否 retry（C14） |
| 403 当掉登录 | 无权限用户陷入反复登录 | 403 → `forbidden`；只有 401/明确登录跳转才是 `unauthenticated` |
| sessionApi 200 就算登录 | 实际返回 SSO 登录 HTML，被误判 | 结合 `loggedInJsonPath` / login URL / DOM markers；不确定返回 `unknown` |
| **导航后立即 `page.evaluate`** | `Execution context destroyed`（SSO 多跳期间） | 先 `await settleNavigation(page)` |
| **认证恢复后从断点继续** | 页面状态已丢失，执行的是不存在的上下文 | C22：从 anchor 重跑幂等前缀 |
| **认证恢复后不校验身份** | 换了人还继续跑，用别人身份提交单据 | C21：identityProbe 比对，不一致强制中止 |
| **自愈未验证直接写回** | 技能库被静默污染 | 先 resolve-only；动作+postcondition 通过后才 commit（C4） |
| **自愈「试点提交按钮」** | 为验证 locator 真的产生业务写入 | write/critical resolve 阶段只能定位，不得执行 |
| 探索循环无步数上限 | 死循环烧 token | `RETRY.exploreMaxSteps`；J4 仅 Stretch |
| 选择器生成器产出 css 兜底 | build 后失效 | 生成 css 时打警告；Mock 典型元素测试要求 0 个 css |
| 录制探针记录 select 本身 click | 多出无效动作 | `.el-select` 内 click 只记录打开状态 |
| 「approverId 校验」不够形成依赖陷阱 | 硬编码录制值仍可能同参数回放成功 | approver 返回动态 `approvalToken`；切换 type 回放验证必须重新取值 |
| **用 response 时间关联动作** | 慢响应被归到后一个 UI action | 只用 `requestTs`（C15） |
| **大响应中的弱值产生假依赖** | 281KB serverinfo 匹配出上万假依赖 | 弱值过滤规则（T-29）；fingerprint 形态例外 |
| Legacy preflight 只会 JSON | `__VIEWSTATE` 无法提取 | GET HTML → DOMParser → selector/attribute |
| **Record/HAR/trace 直接落盘** | Authorization/Cookie/token/password 泄漏 | 统一经 `sanitize.ts`；依赖分析所需 token 用不可逆 fingerprint |
| **双层转义 JWT 逃过脱敏** | `raw.text` 内嵌 JSON 的 `access_token` 明文入盘 | `sanitizeBody` 结构化路径；实测踩过，已有回归用例 |
| **点号 key 崩溃** | `oauth2.device...` 被 `.` split 后遍历崩溃 | 按 body 实际结构最长前缀回溯；同类：key 含 `[` `]` `\` |
| CSRF/ViewState 被当普通参数保存 | 技能含过期/敏感动态值 | YAML 只保存「运行时如何提取」，真实值只留内存 |
| submit 只重放最终请求 | approver/balance 等联动结果缺失 | T-30 必须生成跨步依赖模板 |
| **对 postData 整串正则脱敏** | fingerprint 对不上，依赖识别失效 | 结构化解析后逐字段处理（T-02） |
| Vue2/Vue3 类名差异 | Vue2 页面定位失败 | 走 `compat.ts` 版本探测（条件启用） |
| 浏览器侧代码 import npm 包 | IIFE 注入报错 | `_guard.ts` 构建时拦截 |
| LLM trace 原样记录 | 业务数据或凭证进入日志 | 记录前统一 sanitizer |

---

# 第七部分 · 环境变量

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
DSH_ENTRIES_DIR=./entries
DSH_SKILLS_DIR=./skills
```

---

# 第八部分 · 交付清单

- [ ] 可运行的 monorepo（`pnpm install && pnpm build`）
- [ ] Mock OA 环境（`docker-compose up` 一键启动，含门户页）
- [ ] `dsh` CLI：`doctor` `record` `analyze` `diff` `replay` `run`
- [ ] 至少一份 entry 配置：`entries/oa.yaml`
- [ ] 两个技能文件：`oa_overtime_submit.yaml`、`oa_leave_submit.yaml`
- [ ] Core 验收 CI 报告：A1–A7 + A9 + A11–A12 全绿；A8/A10 若启用则单独报告
- [ ] 五份文档（README + 迁移清单 + 技能编写 + entry 编写 + 排障）
- [ ] 5 分钟演示录屏：录制 → 修正 → 回放 → **rebuild 后仍能回放** → 破坏一步 → 自愈 → **展示 drop_response 不重复提交**

---

# 第九部分 · 遗留决策点

| # | 决策 | 何时决定 | 默认值 |
|---|---|---|---|
| D1 | sanitize 方案 A（结构化 fingerprint）vs 方案 B（依赖识别前移到 recorder） | **M4 结束**：若 T-24 验收出现任何 `fallback`，即切方案 B | 方案 A |
| D2 | 是否启用 Vue2 兼容（T-09B / T-13 / A8） | 内网 `--probe-frontend` 出结果后 | 不启用 |
| D3 | 是否启用 J4 探索（T-49/T-50） | M7 Core 完成后视余量 | 不启用 |
| D4 | 无 postcondition 的技能是否允许发布 | M5 结束前 | 允许，draft 带显式警告 |
| D5 | 是否实现模式 B（预授权 + 无人值守） | 现场拿到 Idle/Max 实测值 + 安全部门对 keepalive 的态度后 | 不实现，仅预留契约 |
| D6 | 二期自动填充选哪种 credentialProvider | 二期启动时 | 一期恒 `none` |

**方案 B（D1 的备选）**：依赖识别前移到录制进程内完成——在 `record()` 结束、写盘之前，用**未脱敏的原始值**跑一遍 T-30 的依赖识别，把结果作为 `RecordSession.dependencies` 写入，随后再脱敏落盘。analyzer 直接读 `dependencies`，完全不依赖 fingerprint。代价：T-24/T-29/T-30 边界重划。

---

# 附录 A · 内网现场必测清单

**这些数据不用写代码就能拿到，且直接决定 D2/D5 两个决策。建议第一天就做。**

## A.1 载体检查

```bash
dsh doctor
```
- [ ] Chrome 版本
- [ ] 是否强制国产浏览器（Chromium 内核可用 `executablePath`；IE 内核 Playwright 不支持，需另议）
- [ ] Chrome Enterprise Policy 是否禁用 `--remote-debugging`
- [ ] 是否需要内网代理 / PAC
- [ ] 是否有浏览器安全插件干扰自动化

## A.2 每个目标系统各跑一次

```bash
dsh doctor --probe-entry --portal <门户URL> --target <系统id>
```
- [ ] 进入方式：portal / direct
- [ ] 跳转链路是否含一次性 token
- [ ] **sessionType：cookie / bearer / mixed**  ← 决定该系统能否用 network 通道
- [ ] `identityProbe` 是否可用
- [ ] 前端框架与组件库版本 ← **决定 D2**

## A.3 会话生命周期（决定 D5）

⚠️ **Idle 和 Max 是两个独立计时器，必须分别确认。**

| 项 | 在哪查 | 实测值 |
|---|---|---|
| Keycloak **SSO Session Idle** | Realm Settings → Sessions | ______ |
| Keycloak SSO Session Max | 同上 | ______（已知设为 7 天）|
| 门户 token idle | 需向门户方确认 | ______ |
| 门户 token max | 同上 | ______ |
| 各子系统会话时长 | 实测 | ______ |
| **真实可用窗口 = min(以上)** | | ______ |

> **常见误判**：Max 设为 7 天，但 Idle 仍是默认 30 分钟 → 18:00 登录、23:00 执行时早已因闲置掉线。**Max 长不代表能用那么久。**
>
> 子系统会话较短不是问题，`ensureEntry` 可重走门户重建；**真正的生命线是门户会话**。

## A.4 认证类型判定

- [ ] 类型 A：AD 域集成认证（Kerberos/NTLM）→ 零交互，最理想
- [ ] 类型 B：表单登录 / SAML / OAuth 跳转 → 首次手动，之后免登
- [ ] 类型 C：客户端证书 → `clientCertificates` 配置

## A.5 合规确认（写代码前完成）

- [ ] 「程序以员工身份自动提交业务单据」的定性，安全/法务书面结论
- [ ] 若考虑 keepalive（主动延长会话），需单独书面同意
- [ ] 审计留痕要求：需要记录哪些字段、保留多久

---

# 附录 B · 测试靶子策略

## B.1 已完成的实测（Keycloak）

| 目标 | 结果 |
|---|---|
| 非 Vue（PatternFly）界面下定位器能否降级 | ✅ 成立，role/css 策略可用 |
| 工具链端到端能否跑通 | ✅ 成立，抓出 4 个真 bug（已全部固化为回归用例） |
| **传统 SSO 模式能否通过** | ❌ **未验证**——实现绕开 SSO 走了 password grant |

## B.2 Keycloak 重测方案（验证 C18）

```
1. 人工在 profile 中登录 Keycloak（一次）
2. dsh doctor --probe-entry --direct http://<kc>/admin/master/console/
   → 预期判定 sessionType: bearer
   → 预期 bearerSource.strategy: global（keycloak.token）或 ui-only
3. 技能从「已在 Clients 列表页」开始录，不含任何登录步骤
4. 回放不做任何认证动作
   → 若判定正确，network 通道应能通过 getLiveAuthHeader 工作
   → 若判定为 ui-only，则该技能所有步骤强制 ui，验证 C18 的 Schema 拒绝生效
```

**这次重测的价值是验证 C18 与 T-57，不是再证明一次工具链能跑。**

## B.3 下一个靶子建议

Keycloak 管理台画像：**React + PatternFly + Bearer + OAuth code flow**
内网 OA 目标画像：**Vue + Element + Cookie session + 门户跳转**

**两者无一维度重合**，所以本次测出的多数结论不会迁移。

建议下一个真实靶子选 **Vue + Element Plus/UI + Cookie 会话**的开源系统（若依 RuoYi-Vue、JeecgBoot 或任意 Element admin 模板）：
- 能真正验证 `el-locator` 全套策略（append-to-body、date-picker、dialog 动画）
- Cookie 会话路径能验证 C2 主路径
- 与内网 OA 画像一致，测出的问题会在内网重现

Keycloak 保留为 **C18 的专项回归靶子**，不作常规测试对象。

---

**文档结束**
