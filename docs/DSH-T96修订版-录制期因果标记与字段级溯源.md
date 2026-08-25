# DSH Browser Skill · T-96（修订版）· 录制期因果标记与字段级溯源

版本：v2.0（替换原 T-96）
日期：2026-08-24
用途：交付 Codex 执行
替换：《T-91 ~ T-96 实战问题修复》中的 T-96 章节整体作废，以本文档为准
关联：v2.0 规格约束 C1–C23；T-94（字面量溯源护栏）

---

## 0. 为什么替换原 T-96

### 0.1 原方案的定位错误

原 T-96 的目标是「correlation 泛化到搜索响应链」，做法是新增 `response-value-match` 策略——**在分析阶段用值匹配去搜整段录制**。

实战暴露的问题证明：**值匹配本身就是补偿性设计，不该作为主力。**

### 0.2 根因：动作记录晚于网络请求

```
用户在搜索框输入 "1"
  ↓ input 事件
前端发出 GET /api/employees/search?keyword=1
  ↓ 用户离开输入框
  ↓ change 事件
录制器此时才记录 fill(value="1")
```

`recorder-probe.ts` 监听的是 `change`，而 `change` 要等失焦、回车或控件主动提交才触发。但实时搜索的请求在更早的 `input` / `keyup` / debounce 后就发出了。

**结果：网络请求发生在录制动作之前。**

为了不漏掉这类请求，`correlate.ts` 放弃了「动作必须在请求之前」这个约束，改为在整段录制中全局搜相同值。这是**为了补偿时序错位而放宽的兜底**。

### 0.3 兜底造成的实际错误

```
actions:  fill("1")
network:  GET /search?keyword=1
          GET /list?page=1

全局搜值 "1" → 两条都匹配 → page=1 被误绑定为搜索参数
```

分析器无法区分「搜索的 1」和「分页的 1」——**因为数据里确实没有区分它们的信息**。

### 0.4 正确方向

**在录制期建立因果关系，而不是在分析期猜测。**

```
监听 input（而非 change）
  → 建立/更新 activeAction { actionIdx: 7, target, value, ts }
  → 此后窗口内发出的请求，直接打上 actionIdx: 7

analyzer 拿到：
  request-1  keyword=1   actionIdx=7    ← 有因果标记
  request-2  page=1      actionIdx=—    ← 无标记
```

**歧义不复存在**——不是靠猜哪个 1 是真的，是根本不用猜。带标记的是搜索，没标记的不是。

### 0.5 关于是否引入 LLM 判别

**不引入。**

「脚本分不清搜索的 1 和 page 的 1」这个困难在当前实现下成立，但在本方案下不存在。

| | 全局搜值 + LLM 判别 | 录制期因果标记 |
|---|---|---|
| 判据 | 模型推测「哪个更像搜索参数」 | **浏览器实际观测到的事件顺序** |
| 确定性 | 同输入可能给不同答案 | 完全确定 |
| 成本 | 每次分析都要调用 | 零 |
| 出错时 | 不知道下次还会不会错 | 规则错了能修、能测、能回归 |

已有实证：T-86 的 `{{s4[0].value}}` 是规则写错了，修完加了回归。若那是模型判断错误，连「下次还会不会错」都无从得知。

沿用项目一贯分工：**LLM 做语言理解，规则做数据处理。参数溯源属于后者。**

---

## 1. 任务拆分

原 T-96 拆为两个子任务，**T-96a 必须先完成**（b 依赖其产出）。

| # | 内容 | 改动范围 |
|---|---|---|
| **T-96a** | 录制期 activeAction 因果标记 | `packages/locator`（探针）、`packages/recorder`（网络录制） |
| **T-96b** | 分析器：actionIdx 优先、字段级溯源、中间态折叠 | `packages/analyzer` |

---

## 2. T-96a · 录制期因果标记

### 2.1 activeAction 上下文

在浏览器侧维护一个实时动作上下文：

```ts
interface ActiveAction {
  actionIdx: number;
  /** 触发该上下文的元素标识 */
  targetKey: string;          // 用于判断"是否同一控件的连续输入"
  target: LocatorStrategy;
  kind: 'input' | 'click' | 'select' | 'check';
  /** 最新值（连续输入时持续更新） */
  value: string | null;
  /** 首次建立时间 */
  startedAt: number;
  /** 最后一次更新时间（窗口从此刻起算） */
  touchedAt: number;
}

window.__DSH_ACTIVE_ACTION__: ActiveAction | null;
```

### 2.2 建立与更新规则

| 事件 | 行为 |
|---|---|
| `input`（文本框、textarea） | 若 `targetKey` 与当前 activeAction 相同 → **更新 value 与 touchedAt，复用 actionIdx**<br>若不同 → 结束旧上下文，新建 |
| `click` | 结束旧上下文，新建（kind='click'） |
| `change`（select / radio / checkbox） | 结束旧上下文，新建（kind='select'/'check'） |
| `blur` | **立即使当前 activeAction 失效**（见 §2.3） |
| 距 `touchedAt` 超过窗口 | activeAction 过期失效 |

**`targetKey` 的构造**：用元素的稳定标识（`tagName + name + type + 在其容器内的序号`），不要用对象引用——SPA 重渲染会换掉 DOM 节点。

### 2.3 窗口规则

```ts
export const CAUSALITY = {
  /** activeAction 建立后，多久内的请求算它触发的 */
  activeWindowMs: 1500,
  /** blur 后的宽限期（覆盖 blur 触发的请求） */
  blurGraceMs: 300,
} as const;
```

判定：

```
请求发出时：
  1. activeAction 为 null              → 不打标记
  2. now - activeAction.touchedAt > activeWindowMs
                                        → 不打标记（已过期）
  3. activeAction 已 blur 且
     now - blurAt > blurGraceMs         → 不打标记
  4. 其余                               → 打上 actionIdx
```

**blur 后必须迅速失效**，否则用户离开输入框后，下一个字段触发的请求会被算到上一个字段头上。`blurGraceMs` 只为覆盖 blur 本身触发的搜索请求（部分组件在失焦时才发请求），不宜设大。

### 2.4 网络录制侧打标

`packages/recorder/src/network.ts` 在 `page.on('request')` 时读取当前 activeAction：

```ts
export interface RecordedRequest {
  // ... 现有字段全部保留

  /** 【新增】触发该请求的动作序号；无因果证据时为 null */
  actionIdx: number | null;
  /** 【新增】因果证据类型 */
  causality: 'active-action' | 'none';
  /** 【新增】诊断用：打标时 activeAction 的快照 */
  causalityDebug: {
    targetKey: string;
    kind: string;
    valueAtRequest: string | null;
    msSinceTouched: number;
  } | null;
}
```

**读取方式**：通过已有的 `exposeBinding` 通道，探针在每次 activeAction 变化时把当前状态推送到 Node 侧，Node 侧维护一份镜像。**不要在 `page.on('request')` 里同步调 `page.evaluate`**——那会引入时序问题且可能在导航期崩溃（C9 / T-95）。

### 2.5 与最终提交请求的关系

**最终 POST 不得整条绑定一个 actionIdx。**

用户填了 5 个字段后点提交，这条 POST 的 body 同时包含 5 个来源不同的值。整条绑到「点提交」那个动作上没有意义。

处理方式：

```
提交类请求（mutating 且非搜索类）：
  - actionIdx 记为触发它的那个 click 动作（用于时序诊断）
  - 但 body 的溯源在 T-96b 做，逐字段进行
  - causality 标记不参与 body 字段的参数化判定
```

### 2.6 不改变的部分

- `requestTs` 语义不变（C15：关联仍不得使用 responseTs）
- 现有的噪音过滤、脱敏、`sanitizeMode` 全部不变
- `change` 监听保留（select / radio / checkbox 仍需要它），只是**额外**增加 `input` 监听

### 2.7 验收

| # | 项 | 期望 |
|---|---|---|
| V-96a-1 | input 建立上下文 | 在搜索框输入触发的请求，`actionIdx` 非 null，`causality: 'active-action'` |
| V-96a-2 | **搜索 vs 分页区分** | 输入 "1" 触发 `keyword=1`，页面另有 `page=1` 请求 → **前者有 actionIdx，后者为 null** |
| V-96a-3 | 连续输入复用 | 逐字输入「王」「王海」→ 两次请求 `actionIdx` **相同** |
| V-96a-4 | blur 后失效 | 离开输入框超过 `blurGraceMs` 后的请求 → `actionIdx: null` |
| V-96a-5 | 窗口过期 | 输入后静置 2 秒再触发的请求 → `actionIdx: null` |
| V-96a-6 | 切换控件 | 在 A 框输入后到 B 框输入 → B 的请求不带 A 的 actionIdx |
| V-96a-7 | debounce 场景 | 输入停止 500ms 后才发的请求 → 仍在窗口内，正确打标 |
| V-96a-8 | 页面自动请求 | 页面加载时的初始化请求 → `actionIdx: null` |
| V-96a-9 | SPA 重渲染 | 输入过程中控件被 Vue 重渲染 → `targetKey` 稳定，actionIdx 不断裂 |
| V-96a-10 | 导航期不崩 | 请求打标逻辑在页面跳转期间不抛异常（配合 T-95） |
| V-96a-11 | 现有回归 | `requestTs` 语义、噪音过滤、脱敏全部不变 |

**V-96a-2 是本任务的核心验收**：它直接对应实战暴露的那个错误。

---

## 3. T-96b · 分析器侧字段级溯源

### 3.1 匹配优先级（全面改写）

原 T-96 的四档优先级作废，新的优先级：

```
1. action-causality           高
   请求带 actionIdx → 直接归属该动作
   参数值取自 activeAction.value

2. response-value-match       高
   请求体的值出现在前置响应中 → 跨步依赖
   （EMP001 这类服务端生成的值仍需靠它）

3. dom-causality              高
   响应值出现在页面 DOM 变更中（T-70 的观测产出）

4. request-value-match        中
   前一动作的输入值出现在请求体中
   【降级】仅在 1 不适用时使用，且必须限定在时间窗内

5. time-window                低
   兜底，必须打 TODO
```

**关键变化**：`action-causality` 成为主力，原来的全局值搜索（`request-value-match`）降为中等且**必须限定时间窗**——不得再扫描整段录制。

### 3.2 字段级溯源（本任务核心）

**溯源粒度是请求体的每个叶子字段，不是整条请求。**

```
POST /api/leave/submit
  body:
    reason:     "版本上线"     → 溯源到 actionIdx=3（填事由）      → 参数
    startTime:  "2026-08-25"   → 溯源到 actionIdx=4（填日期）      → 参数
    leaveType:  "ANNUAL"       → 溯源到 actionIdx=2（选类型）      → 参数
    approverId: "EMP001"       → 溯源到 s5 响应 $.list[0].id       → 跨步依赖
    _csrf:      "abc123"       → 溯源到 preflight.csrf              → 变量引用
    page:       1              → 无法溯源                          → TODO_UNRESOLVED
```

溯源判定链（对每个叶子值，按序）：

```
① 等于某个带 actionIdx 的动作的 value（或其 enumMap 映射结果）
     → 参数，绑定该动作对应的参数名

② 出现在某个前置响应体中（过弱值过滤后）
     → 跨步依赖，生成 {{sN.path}}

③ 等于某个 preflight 变量的值
     → 变量引用，生成 {{varName}}

④ 在豁免清单中（见 §3.3）
     → 常量，原样保留

⑤ 以上皆否
     → TODO_UNRESOLVED
     → _notes 说明可能原因
     → parseSkill() 拒绝加载
```

**这条判定链与 T-94 的字面量溯源护栏是同一套机制**，本任务是把它接上 actionIdx 这个新证据源。**不要另写一份实现。**

### 3.3 豁免清单

以下字面量允许存在，不报 TODO：

- 布尔值 `true` / `false`
- 空值：`null` / `""` / `[]` / `{}`
- 值等于 URL 路径的一部分
- 在 entry 或 skill 层显式声明为常量的字段
- 分页类字段（`page` / `pageSize` / `offset` / `limit`）**且值等于录制时的默认值**
  - 说明：这类字段通常是前端默认值，不是用户输入。**但如果用户在录制中确实翻过页，那次的值应该来自 actionIdx，落在①而不是豁免**

### 3.4 中间态搜索折叠

渐进搜索会产生多条同 actionIdx 的请求：

```
输入「王」   → GET /search?keyword=王      actionIdx=7
输入「王海」 → GET /search?keyword=王海    actionIdx=7
```

**折叠规则**：

```
同一 actionIdx 下、同一端点、keyword 呈渐进包含关系的多条请求
  → 折叠为一个步骤
  → keyword 取最终态（时间最晚的那条）
  → 参数化为 {{对应参数名}}
  → extract 从最终态的响应提取
  → 中间态请求丢弃，不生成步骤
```

**不折叠的情况**：同 actionIdx 但端点不同的请求各自保留（可能是搜索 + 校验两个独立调用）。

### 3.5 搜索结果的提取与重名护栏

```yaml
- id: s4
  desc: 搜索审批人
  channel: network
  network:
    method: GET
    url: "/api/employees/search?keyword={{审批人姓名}}"
    extract:
      approverId: "$[?(@.name=='{{审批人姓名}}' && @.department=='{{审批人部门}}')].id"
```

**重名护栏**（实战已确认真实 OA 存在两个「张三」）：

```
搜索响应是数组且长度 > 1：
  1. 从录制时用户实际选中的那一项，提取判别特征
     优先级：(name, department) > (name, 其他唯一字段) > 无
  2. 生成条件提取表达式
  3. 若找不到能唯一判别的特征组合
     → TODO_UNRESOLVED
     → _notes：「搜索返回多条结果，无法确定唯一判别特征，
                 请手动指定或改用更精确的搜索条件」

【禁止】静默取 $[0]
```

**与 T-86 禁止的下标取值的区别**（必须在代码注释中说明，避免后人误改）：

| | T-86 禁止的 | 这里的 |
|---|---|---|
| 形态 | `type: "{{s4[0].value}}"` | `extract: {approverId: "$[?(...)]..."} ` |
| 含义 | 取列表第一项作为**参数值** | 从搜索结果按条件取**依赖值** |
| 问题 | 与调用方参数无关，永远取同一项 | 搜索词本身是参数，结果随之变化，且有判别条件 |

**但无条件的 `$[0]` 仍然禁止**——那退化成 T-86 那个问题。

### 3.6 低置信度必须显式标注

`time-window` 兜底时，除 `_correlation.confidence: low` 外，draft 必须有 TODO：

```yaml
_correlation:
  method: time-window
  confidence: low
  ownerAction: s4
  evidence: "距最近前置动作 505ms，无因果标记"
# TODO: 此请求的归属由时间窗推断（置信度低）。
# 该请求未携带 actionIdx，可能由页面自动触发而非用户操作。
# 请确认它是否应归属于 s4，或从技能中移除。
```

### 3.7 验收

| # | 项 | 期望 |
|---|---|---|
| V-96b-1 | actionIdx 优先 | 带 actionIdx 的请求走 `action-causality`，`confidence: high` |
| V-96b-2 | **page 不被误绑** | 实战场景复现：输入「1」+ 页面有 `page=1` → **`page` 不被参数化**，落到豁免或 TODO |
| V-96b-3 | 字段级溯源 | 一条 POST 的 5 个字段分别溯源到 3 个不同动作 + 1 个响应 + 1 个 preflight |
| V-96b-4 | 中间态折叠 | 逐字输入产生 2 条搜索请求 → draft 中**只有 1 个搜索步骤**，keyword 为最终态 |
| V-96b-5 | response-value-match | `EMP001` 正确溯源到搜索响应，生成跨步引用 |
| V-96b-6 | 重名护栏 | 搜索返回 2 条同名 → 生成 `(name, department)` 条件提取，**不取 $[0]** |
| V-96b-7 | 无判别特征 | 构造无法判别的场景 → `TODO_UNRESOLVED`，`parseSkill()` 拒绝 |
| V-96b-8 | 无法溯源报错 | 请求体含无来源字面量 → `TODO_UNRESOLVED`（复用 T-94 护栏） |
| V-96b-9 | 豁免清单 | 布尔、空值、URL 片段、默认分页值不误报 |
| V-96b-10 | 真实 OA 置信度 | 加班流程的 7 个联动请求，**≥ 5 个**达到 high（原 0/7） |
| V-96b-11 | 慢节奏一致 | 慢节奏录制（每操作 ≥2.2s）的 correlation 质量与快节奏一致 |
| V-96b-12 | 弱值过滤回归 | 大响应中的布尔/小整数不产生假依赖（T-29 回归） |
| V-96b-13 | 跨参数回放 | 录制 A 参数 → **不做人工修正** → B 参数回放 → 服务端记录为 B（贴 history 原文） |

**V-96b-2 是本任务的核心验收**：它直接证明实战那个错误被修掉。

---

## 4. 契约变更

以下为本文档明确允许的新增，其余不得改动 v2.0 冻结契约。

```ts
// RecordedRequest 新增
actionIdx: z.number().nullable()
causality: z.enum(['active-action', 'none'])
causalityDebug: z.object({...}).nullable()

// Step._correlation 的 method 枚举扩展
method: z.enum([
  'action-causality',      // 【新增】
  'response-value-match',
  'dom-causality',
  'request-value-match',
  'time-window',
])

// constants.ts 新增
export const CAUSALITY = {
  activeWindowMs: 1500,
  blurGraceMs: 300,
} as const;
```

浏览器侧全局对象新增：

```ts
window.__DSH_ACTIVE_ACTION__: ActiveAction | null
```

---

## 5. 执行与报告

### 5.1 顺序

**T-96a 必须先完成并通过验收，再开始 T-96b。** b 依赖 a 产出的 `actionIdx` 字段。

### 5.2 必须停下的情况

1. **V-96a-2 未通过**（搜索与分页仍无法区分）→ 停止，不继续 T-96b。这是本任务的存在理由。
2. 需要修改 §4 之外的冻结契约 → 停止，先提变更提案。

### 5.3 报告格式

```
T-96a 录制期因果标记
  V-96a-1 input 建立上下文:    PASS / FAIL
  V-96a-2 搜索 vs 分页区分:     PASS / FAIL      ← 核心
    keyword 请求 actionIdx:     ______
    page 请求 actionIdx:        ______（期望 null）
  V-96a-3 连续输入复用:         PASS / FAIL，两次 actionIdx=__/__
  V-96a-4 ~ V-96a-11:           逐项

T-96b 字段级溯源
  V-96b-2 page 不被误绑:        PASS / FAIL      ← 核心
    page 字段最终归类:          [豁免/TODO/参数（错误）]
  V-96b-3 字段级溯源:           5 字段溯源结果逐项列出
  V-96b-4 中间态折叠:           搜索步骤数=__（期望 1）
  V-96b-6 重名护栏:             生成的 extract 表达式=______
  V-96b-10 真实 OA:             high 置信度 __/7
  V-96b-13 跨参数回放:          PASS / FAIL
    服务端 history 原文:        ______
  其余逐项

回归
  unit / e2e / T68-T74+T84 / T-91~T-95 验收项
```

---

## 6. 注意事项

### 6.1 全局值搜索是补偿，不是设计

`correlate.ts` 当初放宽「动作必须在请求之前」这个约束，是为了不漏掉实时搜索请求。这个补偿在实战中被证明会产生错误绑定。

**本轮修完之后，全局值搜索必须收窄**：
- `request-value-match` 降为中等优先级
- 且必须限定在时间窗内，不得扫描整段录制
- 不得为了「多匹配上一些」而放宽窗口

### 6.2 溯源粒度是字段不是请求

最容易实现错的地方：把整条 POST 绑定到一个 actionIdx。

一条提交请求的 body 通常包含多个来源不同的值（多个字段的输入 + 响应依赖 + preflight）。**必须逐字段溯源。**

### 6.3 不引入 LLM

参数溯源是数据处理，不是语言理解。规则错了能修、能测、能加回归；模型判断错了无法保证下次不错。

已有先例：T-86 的 `{{s4[0].value}}` 是规则 bug，修复后加了回归用例，现在可以确定它不会重现。

### 6.4 复用而非重写

以下机制已存在，本任务必须复用而非另写：

| 机制 | 位置 | 用途 |
|---|---|---|
| 弱值过滤 | T-29 | 防止 `code=0` 类值产生假依赖 |
| 字面量溯源护栏 | T-94 | 溯源失败 → TODO_UNRESOLVED |
| DOM 变更观测 | T-70 | `dom-causality` 证据源 |
| exposeBinding 通道 | 现有 | activeAction 状态推送 |
| sanitize | T-02 | `causalityDebug` 落盘前脱敏 |

### 6.5 不要在 request 事件里同步 evaluate

`page.on('request')` 回调中调 `page.evaluate` 读取 activeAction 会引入两个问题：时序不确定（可能读到已变化的状态）、导航期崩溃（C9 / T-95 踩过）。

**必须走 exposeBinding 推送 + Node 侧镜像。**

### 6.6 不要扩范围

发现值得做但不在本轮的，记录在报告「建议」段落，不要实现。特别是 T-91~T-96 §0.3 的不做清单继续有效。

---

## 7. 一句话总结

> 「输入 1 触发的搜索」和「分页的 page=1」在数据里本来就分不开，
> 因为录制器用 `change` 监听，请求早于动作记录，只能事后全局搜值。
> 修法不是让模型去猜哪个 1 是真的，是改用 `input` 监听，在请求发出的那一刻就把它和当前动作绑起来——
> **歧义在录制期就被消除，分析期不需要猜。**

---

**文档结束**
