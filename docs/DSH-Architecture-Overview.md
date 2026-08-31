# DSH Browser Skill 架构总览

版本：Phase 3 Cutover 后
面向读者：首次接手项目、尚未阅读 Phase 0–3 历史文档的维护者

## 1. 系统现在只有一条链路

```text
用户在已登录浏览器中操作
  → Canonical Recorder（interaction + 标准 DOM/ARIA/IDL 状态 + HTTP 因果）
  → CanonicalAction IR（唯一动作真相源）
  → Analyzer（请求归属、字段级溯源、容错）
  → ValueLineage（值从哪里来、以什么表示、是否同源）
  → Channel Planner（network/ui/merged 与 carrier）
  → Replay（请求前守卫、页面内 fetch、UI 语义动作、落库核验）
```

Phase 3 已删除 legacy recorder、`RecordSession.actions`、`recorderPath`、shadow compare 和四个框架命名 locator strategy。历史 `record.json` 不迁移；测试数据全部可重新录制。

### 1.1 录制层

录制从 entry 会话已建立之后开始，登录不属于技能。Recorder 记录所有可观察 interaction；分类只决定 IR 标签，绝不决定“是否记录”。`CanonicalAction.raw.eventTypes` 保留合并前事件序列，target 记录交互发生时的标准语义，effects 保存请求、导航和受限的 DOM mutation 证据。

### 1.2 IR 与分析层

Canonical IR 是唯一真相源。Analyzer 只使用浏览器、DOM、HTTP 和数据流事实：

- 请求归属优先使用浏览器标记和 `requestTs`；
- 请求/响应叶子值只能在受限因果窗口内辅助关联；
- 无法证明的写请求字面量变成 `TODO_UNRESOLVED`；
- 合法录制中的局部异常不得让整个 Analyzer 崩溃。

### 1.3 ValueLineage

参数身份来自 source lineage，不来自值。Lineage 描述 source、representation、cardinality 和 identity；两个值相等不代表同一个参数。一个 source 可以因 SPA 重渲染跨多个 DOM 实例，但不同 source 默认保持独立。

标准控件 live IDL `value/checked` 是用户输入证据。由动作导致、被请求消费且具有 locator 的非表单 `textContent` 才可能成为内部 `page-derived`。页面派生值不进入调用方参数签名，外部覆盖会在发送请求前中止。

### 1.4 Channel Planner

每个步骤独立规划：

- `network`：在当前页面上下文执行 fetch；
- `ui`：用标准语义定位器执行；
- `merged`：只物化上下文值；
- `auto`：仅在机械判定为 `not_sent` 且所有 recovery carrier 完整时才允许 UI 降级。

Planner 不能在运行时发明 carrier。依赖 merged 值的 network 步骤若失败为 `not_sent`，但 UI 没有等价 carrier，必须抛 `ChannelCarrierMissingError`，不能提交空值或错误值。

### 1.5 回放与成功判定

写动作确认、参数校验、`TODO_UNRESOLVED` 扫描、page-derived override 检查都发生在副作用前。写请求结果分为 `not_sent`、`confirmed_success`、`confirmed_failure`、`outcome_unknown`；后两者和响应丢失都不能自动 UI 重提。

成功不是 HTTP 200。每个报告成功的回归格位必须保存调用参数与服务端落库原文，并逐字段比较；没有原文的格位只能标为“未验证”。

## 2. C1–C28 当前状态

| 约束 | 当前状态 | Phase 3 后的有效含义 |
|---|---|---|
| C1 | 有效 | channel 是步骤级属性，可在同一技能混用。 |
| C2 | 有效 | network 请求在页面上下文 fetch，复用当前浏览器会话。 |
| C3 | 有效 | 核心链路不依赖视觉能力；截图只用于诊断，不是决策前提。 |
| C4 | 有效 | 自愈先 resolve-only；写动作经确认且 postcondition 通过后才可写回。 |
| C5 | 有效 | LLM 只能从固定动作集提案，并经过 schema、约束和 Playwright oracle 校验。 |
| C6 | 有效 | write/critical 始终需要确认；无人值守测试豁免不得进入产品默认。 |
| C7 | 有效 | 定位基于 label/ARIA/Playwright 语义；框架私有 class 与脆弱路径不得进入 core。 |
| C8 | 有效 | 凭证只存在于用户浏览器会话，不落 DSH 配置、skill、record 或日志。 |
| C9 | 有效 | 浏览器注入 bundle 零运行时 npm/Node 依赖。 |
| C10 | 有效 | LLM trace 可审计且落盘前脱敏。 |
| C11 | 有效 | Record、诊断、trace 与 HTTP 证据统一经过 sanitizer。 |
| C12 | 有效并强化 | 四态 outcome 保留；Silent Wrong Success 还必须以落库原文逐字段比较。 |
| C13 | 有效 | 认证四态分离，403 是 forbidden，不是掉登录。 |
| C14 | 有效 | Session Recovery 只恢复认证，不重放业务动作。 |
| C15 | 有效 | 动作请求关联使用 request 发起时刻，禁止用 response 到达时刻。 |
| C16 | 有效 | 技能不含登录；entry 与用户浏览器负责建立会话。 |
| C17 | 有效 | 禁止 password grant、client secret、明文密码和 API key 换取会话。 |
| C18 | 被后续裁决取代 | “bearer 一律不能走 network”已废止；现在从当前浏览器就地读取 Authorization 并以 `<FROM_BROWSER>` 占位，读取失败为 `not_sent`，仍不缓存、不落盘。 |
| C19 | 有效 | 一次性认证跳转 URL 不录制、不重放。 |
| C20 | 有效 | 预授权不覆盖 critical。 |
| C21 | 有效 | 认证恢复后身份 digest 不一致必须中止。 |
| C22 | 有效 | 重入从幂等 anchor 重建前缀，不从页面断点继续。 |
| C23 | 有效（未来能力边界） | 若以后接外部保管库，只能短暂注入登录表单并立即清内存，不能变成 DSH 凭证存储。 |
| C24 | 有效并由 CI 强制 | fixture 发现只有转写为 DOM/ARIA/Browser/HTTP/Dataflow 通用规则后才能进入 `packages/*`。 |
| C25 | 被补充裁决取代原字面表述 | 请求须沿已录制因果链回溯到 interaction、navigation/page lifecycle 或已确认 response dependency；禁止 Analyzer 猜出录制中不存在的请求。 |
| C26 | 有效 | 页面实例值必须在最后一次相关 navigation 之后、消费请求之前提取；`untouched` 不等于 immutable。 |
| C27 | 有效 | 合法 RecordSession 的局部异常降级为 TODO/notes；只有整体输入非法才允许顶层失败。 |
| C28 | 被补充裁决取代原字面表述 | 废止“DOM 控件实例一一对应”；最终规则是 source lineage identity，只有可靠同源证据或人工声明才共享。 |

没有一条约束因 Phase 3 删除 canonical 能力而失效；不再适用的是旧架构载体本身：legacy action model、recorder path switch、shadow compare 和框架命名 strategy，它们不是继续保留的产品约束。

## 3. 明确不支持的边界

- 提交时刻才由前端生成、又无法从 DOM、preflight、响应或前序步骤稳定提取的时间戳、UUID、设备标识；结果是 `TODO_UNRESOLVED/not_sent`。
- 没有稳定 locator 的纯展示节点派生值。当前观测限于值载体，C16 合计文本类场景不自动固化。
- 无标准 `<option>` 或 `role=option` 证据的自定义枚举全集；只记录已选值，静态值域保持未证明。
- 调用方覆盖 `page-derived`/`page-instance` 内部值；这是建模冲突，抛错而不是“以某一边优先”。
- network multipart 在没有完整浏览器文件 carrier 时的 UI 降级重建。
- 无落库原文的“成功”验收；只能标为未验证。

## 4. 三条不可让步原则

1. **分类只打标签，永不决定是否记录。** unknown 也要保留原始事件证据。
2. **参数身份来自 source lineage，不来自值。** 相同、相似或同名都不能成为合并理由。
3. **Silent Wrong Success 恒为 0。** 定义为回放报告成功但落库字段不等于调用值；每个成功格位必须有逐字段落库对照。

## 5. CI 与长期守卫

| 守卫 | 命令/位置 | 防止的问题 |
|---|---|---|
| 通用化检查 | `scripts/check-no-framework-specifics.mjs` | 框架类名、产品名重新流入 `packages/*`。 |
| 包边界 | `scripts/check-package-boundaries.mjs` | core/adapter/上层依赖方向倒置。 |
| 总约束 | `npm run check:constraints` | 安全、通用化和边界规则漏跑。 |
| Schema 与 Safety 单测 | `packages/core/src/*test.ts` | 旧 strategy、未解析字面量、凭证与非法技能进入执行。 |
| Matrix 落库对照 | `e2e/matrix/matrix.spec.ts` | HTTP 成功但字段落错的 Silent Wrong Success。 |
| merged 长期回归 | `e2e/fallback.spec.ts` | `not_sent` 后用不完整 UI carrier 静默提交。 |

`adapters/` 必须保持只有 `.gitkeep` 和 README。它表示框架适配边界存在，但当前没有任何标准语义无法表达的适配需求；core 永远不得 import adapter。

## 6. 不能删除的回归样本

- **Matrix C9（简单数值参数化的一端）**：滑块数值必须从调用参数进入落库，防止录制初值覆盖调用值。
- **Matrix C14（跨表示映射的一端）**：搜索型下拉的显示值与 wire value 必须由有证据的映射连接，防止返回成功但落错 ID/编码。

二者分别覆盖“同表示直传”和“显示值→传输值映射”，共同夹住参数化正确性的两端。任何架构重构都必须保留它们及逐字段落库核验。

## 7. 维护者修改前检查

修改录制或 Analyzer 前先回答：规则能否脱离当前 fixture 的端点、字段、框架和产品名成立？修改参数化前先画出 source lineage；修改 fallback 前先列出 network 与 UI 的完整 carrier。若无法回答，保持失败显式并新增证据，不要增加猜测性回退。
