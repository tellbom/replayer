# DSH Browser Skill · Phase 2 · Dataflow

版本：v1.0
日期：2026-08-29
用途：**交付 Codex 执行**（开发任务）
上游：Phase 1 Gate 通过（GLM 验证报告，被测 commit `fe9cbb0`）
后续：Phase 2 完成后由 GLM 做 Gate 验证

---

## 0. 交付对象与前置

| 角色 | 职责 |
|---|---|
| **Codex** | 执行本文档全部任务 |
| **GLM** | Phase 2 完成后做 Gate 验证 |
| 裁决 | 评估后决定是否进入 Phase 3（Cutover） |

### 0.1 Phase 1 遗留的两项小修【开工前完成】

以下两项是 Phase 1 的设计疏漏，不算 Phase 2 范围，但必须先修。

#### 2-0-A · `SemanticTarget` 采集时机错误【必修】

GLM 在真实系统上发现：

```
按钮文案在点击后自身变化（「＋ 华东」→「－ 华东」）
canonical 取 settle 之后的名字 → 记录成「－ 华东」
legacy 取点击那一刻的名字 → 记录成「＋ 华东」
```

**动作没丢，但 `SemanticTarget.accessibleName` 记的是错的。** 回放时按「－ 华东」去找，页面上是「＋ 华东」，定位失败。

**根因**：`before`/`after` 是**状态观察**，`target` 是**身份标识**——身份必须是动作那一刻的。当前实现把两者的采集时机混为一谈。

**修复**：

```
SemanticTarget 在动作发生时刻采集（与 before 同时）
ObservableState.after 仍在 settle 之后采集

两者时机分离，不得共用同一次采集
```

**影响面**：自变更控件（展开/收起、点赞/取消、勾选/取消、加入/移除）在真实系统中非常常见。

**验收**：构造一个点击后自身文案变化的按钮，确认 `target.accessibleName` 记录的是**点击前**的文案。

#### 2-0-B · settle 边界偶发拆分同一点击【先定级】

GLM 观察到同一次点击偶发被拆成两个 `CanonicalAction`，会导致 `actionIdx` 与后续请求的因果关联出错。

**先定级**：

```
① 复现该现象，记录复现条件
② 判定属于哪种：
   a. 偶发时序问题 → 调整 settle 窗口常量
   b. targetKey 不稳定 → 同目标判定有缺陷，需修合并规则
③ 定级结论写进报告，再动手
```

**若为 (b)**，优先级提升——`targetKey` 不稳定会影响 T-96 的整个因果体系。

---

## 1. 本阶段目标

### 1.1 一句话

> **让 Analyzer 直接消费 Canonical IR，用 ValueLineage 表达值的身份与来源，用显式 Channel Planner 表达值的载体。**

### 1.2 当前状态与要解决的问题

Phase 1 把捕获层修好了——**动作和状态都被完整记录**。但消费端断了：

```
CanonicalAction（证据完整）
    ↓
ir-downgrade.ts（过渡件，丢 label）
    ↓
RecordedAction（信息已损失）
    ↓
Analyzer（基于旧模型）
    ↓
参数名退化为 fill / fill_2 / select / checkbox
参数与请求体绑定断裂
多值 enum 退化回 boolean
    ↓
19 格中仅 2 格可回放
```

**根因不是"Phase 2 还没做"，而是过渡件设计不足**——`label` 是 IR 里已采集的事实（`SemanticTarget.accessibleName` / `neighborhood.labelText`），降级桥没传下去。

**裁决：不补降级桥，直接让 Analyzer 消费 IR。** 给一个注定要删的过渡件打补丁没有价值。

### 1.3 Phase 2 的三根主轴

| 主轴 | 内容 | 解决 |
|---|---|---|
| **A · IR 直连** | Analyzer 直接消费 `CanonicalAction`，删除降级桥 | 参数桥断裂、label 丢失、19 格仅 2 格可回放 |
| **B · ValueLineage** | 值的身份与来源建模（source / representation / cardinality） | 参数命名、多值分配、enum 值域、F-8 类问题 |
| **C · Channel Planner** | 显式载体规划，消灭隐式 fallback | merged 载体、文件上传、跳转型提交 |

---

## 2. 任务 A · Analyzer 直连 IR【第一优先级】

### 2.1 目标

```
CanonicalAction[]
    ↓（直接消费，无中间转换）
Analyzer
    ↓
draft.yaml
```

删除 `packages/analyzer/src/ir-downgrade.ts` 及 `RecordSession.actions` 的派生填充。

### 2.2 交付

**① Analyzer 入口改为消费 `CanonicalAction[]`**

现有各模块（`correlate.ts` / `params.ts` / `preflight.ts` / `draft.ts`）的输入类型全部改为 IR。

**② 充分利用 IR 中已有但此前丢失的信息**

| IR 字段 | 此前状态 | 应当用于 |
|---|---|---|
| `target.accessibleName` | 降级时丢失 | 参数命名首选 |
| `target.neighborhood.labelText` | 降级时丢失 | 参数命名次选（含无 `for` 关联的邻近 label） |
| `target.name` | 降级时丢失 | 参数命名、多值分组判定 |
| `target.role` / `inputType` | 降级时丢失 | representation 推断 |
| `before` / `after` | 降级时丢失 | 值变化观察、derived 判定 |
| `after.affected` | 降级时丢失 | 程序化值变化溯源 |
| `enumOptions` | 部分保留 | enum 值域 |
| `raw.eventTypes` | 降级时丢失 | unknown 动作的证据 |
| `effects.requestIds` | 保留 | 因果关联 |

**③ `unknown` / `key` / `upload` 动作不再被丢弃**

降级桥此前直接丢弃这三类。IR 直连后必须处理：

```
unknown → 不参与参数化，但保留为步骤（回放时按 raw.eventTypes 重放原始交互）
          若无法重放 → TODO_UNRESOLVED
key     → 生成对应的键盘动作步骤
upload  → 见任务 C 的文件上传
```

**④ 删除过渡件**

```
删除 packages/analyzer/src/ir-downgrade.ts
删除 RecordSession.actions 在 canonical 路径下的派生填充
RecordSession.actions 仅在 recorderPath='legacy' 时有内容
```

**⑤ Shadow compare 的处置**

Phase 1 的 shadow compare 依赖降级桥。删除后：

```
保留 shadow compare 的能力，但改为「IR 层对比」：
  legacy 路径 → RecordedAction[]
  canonical 路径 → CanonicalAction[]
  对比在语义层做（动作类型 + target 语义），不再要求结构一致

若实现成本过高 → 允许停用 shadow compare
  理由：Phase 1 Gate 已通过，其使命已完成
  但必须在报告中明确说明停用
```

### 2.3 C5 崩溃必修【不得再推】

摸底时代报告的 `prompt:null` ZodError，Phase 0 和 Phase 1 都不在范围，**canonical 路径下仍复现**。

**这违反 C27（分析器输入容错，不得未捕获异常），已跨三个阶段未修。**

```
修复要求：
  label / accessibleName / value 为空或缺失时
    → 不参与参数化
    → 该步骤保留（仍可执行）
    → _notes 记录原因
    → 【不得抛异常】

配套：补测 ≥5 种畸形输入，全部产出 draft，零未捕获异常
```

### 2.4 验收

| # | 项 | 期望 |
|---|---|---|
| V-A-1 | 降级桥删除 | `ir-downgrade.ts` 不存在；grep 无引用 |
| V-A-2 | 参数命名恢复 | 摸底 fixture 各格的参数名不再是 `fill` / `fill_2` / `select` / `checkbox` |
| V-A-3 | 参数-请求体绑定 | draft 的 network body 中，参数引用不再全为 `TODO_UNRESOLVED` |
| V-A-4 | 回放恢复 | 19 格中可回放格数 **≥ 12**（当前 2） |
| V-A-5 | unknown 不丢弃 | unknown 动作在 draft 中有对应步骤或明确的 TODO |
| V-A-6 | C5 崩溃修复 | canonical 路径下 C5 不再抛 ZodError，产出 draft |
| V-A-7 | 畸形输入 | ≥5 种畸形录制全部产出 draft，零未捕获异常 |
| V-A-8 | Safety Gate 无退化 | Silent Wrong Success = 0，TODO 提交 = 0 |

**V-A-4 的数字是指标不是硬性**——若未达到，需逐格说明剩余失败的归因（是 ValueLineage 未完成，还是别的问题）。

---

## 3. 任务 B · ValueLineage

### 3.1 模型

```ts
// packages/core/src/lineage.ts（新增）

export interface ValueLineage {
  /** 值从哪来 */
  source: ValueSource;
  /** 值以什么形态存在与提交 */
  representation: ValueRepresentation;
  /** 单值还是多值 */
  cardinality: 'single' | 'multiple';
  /** 身份：来自哪个控件 / 哪次响应 / 哪个页面实例 */
  identity: LineageIdentity;
}

export type ValueSource =
  | { kind: 'user-input'; actionIdx: number }        // 用户输入/选择
  | { kind: 'response'; requestId: string; path: string }  // 前置响应
  | { kind: 'page-instance'; pageSnapshotId: string; locator: LocatorStrategy }
  | { kind: 'derived'; dependsOn: string[] }         // 前端计算派生
  | { kind: 'environment' }                          // 浏览器/环境生成
  | { kind: 'constant' }
  | { kind: 'unresolved'; reason: string };

export interface ValueRepresentation {
  /** 提交时的形态 */
  wire: 'string' | 'number' | 'boolean' | 'enum' | 'file' | 'json';
  /** 若为 enum：值域与 label→value 映射 */
  enumDomain?: {
    map: Record<string, string>;
    /** 值域是否随其他参数变化（contextual） */
    contextual: boolean;
    /** 值域来源 */
    origin: 'dom-options' | 'response' | 'recorded-only';
    complete: boolean;
  };
  /** 显示值与提交值不同时（label vs value） */
  hasDisplayValue: boolean;
}

export interface LineageIdentity {
  /** 控件身份，不是值 */
  controlKey?: string;
  /** 用于人类可读的命名 */
  displayName?: string;
  /** 多值时的分组键 */
  groupKey?: string;
}
```

### 3.2 参数身份规则（C28 落地）

**参数身份来自 source lineage，不来自值。**

```
① 不得仅因值相同而合并参数
② 不得仅因值相似而合并参数
③ 不得因参数命名冲突而复用已有参数
④ 默认不同 source lineage 保持独立
⑤ 只有存在可靠同源证据或人工显式声明时才允许共享

同一逻辑参数可以合法跨：
  SPA rerender / 多页向导 / 重复确认控件 /
  同源参数在不同 UI instance 再次出现
```

**同源证据优先级**：

```
interaction/action provenance（同一 actionIdx 序列）
+ 标准 DOM 语义（name / type / role / associated label / form scope）
+ stable locator fingerprint

容器内位置 → 只能作为 tie-breaker
禁止把 locator + nth 作为参数身份的主要真相

若无法证明同源 → 宁可生成两个独立参数，也不自动合并
```

### 3.3 参数命名优先级链

**动作类型兜底（`fill`）不可接受**——调用方无法理解。

```
① target.accessibleName
② target.neighborhood.labelText（含无 for 关联的邻近 label）
③ target.placeholder
④ aria-label
⑤ target.name 属性
⑥ 提交时对应的请求体字段名        ← 现成信息，此前未用
⑦ 位置描述（如「第 3 个输入框」）
⑧ 动作类型                        ← 最后兜底，且必须带 TODO 标注
```

**第 ⑥ 级特别注意**：摸底报告发现 C9 的 body 是 `level: "{{fill}}"`——**字段名 `level` 就在手边却没用**。

### 3.4 cardinality 与多值分配

**这是原 T-109 的问题域**（该任务已在 Phase 0 停止，其探索保存在 stash）。

#### 复选控件的语义判据（HTML 标准，无框架语义）

```
① 同一 name 分组下的控件数量 > 1
     → cardinality: 'multiple'，wire: 'enum'
② 该控件的 value 属性存在且非默认值（非空、非 "on"）
     → cardinality: 'single'，wire: 'enum'
③ 其余
     → cardinality: 'single'，wire: 'boolean'

数据不足以判定分组时 → 保守判为 ② 单值枚举，不判 boolean
理由：多值误判为 boolean 会静默写错数据（F-8）；
      boolean 误判为单值枚举只是传值稍冗余
```

#### 多值到多控件的分配

一个 `cardinality: multiple` 的参数对应多个控件实例：

```
分配依据：enumDomain.map 的 value → 对应控件的 value 属性
回放时：传入 ["A","B"] → 勾选 value 为 A 和 B 的控件，其余取消勾选

【禁止】按位置分配（数组第 n 项对应第 n 个控件）
理由：控件顺序会随页面改版变化
```

### 3.5 enum 值域

#### 来源优先级

```
① 录制时该控件在 DOM 中的全部可选项
   （原生 select.options、role=option 元素集合）
   → enumOptions（Phase 1 已采集，complete 标记可用）

② 若该控件的选项由某个响应填充
   （因果关系由 DOM 变更观测提供：该响应到达后，
     该控件可选项从空变为非空）
   → 从该响应构建【静态映射表】写入 draft

③ 都无法获取 → 只含录制值，contextual 标记为 unknown，
   _notes 标注跨参数需人工补全
```

#### contextual 判定（防止静态固化错误）

```
判为 contextual（不得静态固化）的条件，任一成立：

① 跨录制对比：两份录制中同一控件的 enumOptions 不同
② DOM 变更因果：某个上游控件变化后，该控件的选项集合发生变更
   （复用 T-70/T-96 的因果体系，不另造）

判为 static 的条件：
③ 页面加载时即存在，且全程未变
```

**反例**（必须能正确处理）：

```
上游选 A → 下游选项 = [X, Y]
上游选 B → 下游选项 = [P, Q]

不得把录制时看到的 [X, Y] 永久写成该参数的全部值域
```

#### 与 T-86 禁止形态的区别（必须在代码注释中写明）

| | 允许 | 禁止 |
|---|---|---|
| 形态 | 从响应构建静态映射表写入 draft | 运行时按数组下标取值 |
| 示例 | `enumMap: {A: a, B: b}` | `type: "{{sN[0].value}}"` |
| 差别 | 映射表是静态数据，回放时按参数查表 | 下标取值与调用方参数无关，永远取同一项 |

### 3.6 derived 与 environment 的处置

摸底报告的 V6 / V8 两类值，Phase 2 必须给出明确处置。

#### derived（前端计算派生，如合计金额）

```
source: { kind: 'derived', dependsOn: [...] }

处置：依赖提取
  回放时从页面读取该字段的当前值（前端已算好）
  不参数化（调用方无法保证与明细一致）
  不重新计算（DSH 不知道计算规则）

若走 network 通道无法读页面 → TODO_UNRESOLVED，拒绝加载
```

**来源判定边界（Phase 2 固化）**：

- 因果链中标准表单控件的 IDL `value` / `checked` 发生变化，表示用户直接输入或选择；归为 `user-input`，不得因为该值同时出现在请求中就改判为 derived。
- 因果链中非表单展示节点的 `textContent` / 可访问状态发生变化，且请求叶子值与之匹配，才可作为 `derived` 候选。
- `textContent` 只说明页面展示了一个值，不单独证明其来源或依赖关系；必须同时存在动作因果归属、稳定 locator 和请求消费证据。任一证据缺失均生成 `TODO_UNRESOLVED`，不得全页搜索相同文本或猜测计算规则。
- runtime 的读取能力与录制期定位证据是两件事：即使 runtime 能读取 `textContent`，录制中没有该展示节点的 locator，也不得生成 page-derived carrier。

这一边界是 DOM/浏览器/数据流规则，不依赖控件库、业务字段或端点。

**已知问题**：GLM 报告指出，合计 span 这类**纯展示元素**的值变化**未进 `after.affected`**（mutation tracker 只跟"值载体"）。

**本阶段必须回答**：依赖提取时靠什么定位这类元素？

```
方案候选：
  a. 扩展 affected 采集范围到纯展示元素（有性能与噪音成本）
  b. 从 domMutations 中提取（Phase 1 证明它保留了完整记录）
  c. 提取时按 locator 直接读，不依赖录制期的 affected

倾向 (b) 或 (c)。选择理由写进报告。
```

#### environment（时间戳、UUID、设备标识）

```
分三类：

① 页面 DOM 中可读的（如 hidden 里的 requestId）
   → source: 'page-instance'，走 T-103 页面实例提取

② 提交时刻由 JS 生成、DOM 中不可读的（如提交时刻的时间戳）
   → source: 'environment'
   → DSH 无法知道生成规则
   → TODO_UNRESOLVED，拒绝加载
   → _notes 明确说明：「该值在提交时刻由前端生成，
      DSH 无法重现其生成规则。若该字段可由调用方提供，
      请手动改为参数；否则该技能无法自动回放。」

③ 【绝对禁止】提交 "TODO_UNRESOLVED" 字面量（Phase 0 已守卫）
```

### 3.7 验收

| # | 项 | 期望 |
|---|---|---|
| V-B-1 | 参数命名 | 摸底 fixture 全部格位无 `fill` / `select` / `checkbox` 类兜底命名（除非确实八级全空且带 TODO） |
| V-B-2 | 参数身份 | 两个不同控件即使录制值相同，产生两个独立参数 |
| V-B-3 | 命名冲突 | 冲突时加后缀区分，不合并 |
| V-B-4 | 多值判定 | 同 name 多控件 → `cardinality: multiple`，非 boolean |
| V-B-5 | 多值回放 | 传入两个值 → 落库为两值集合（**贴服务端原文**） |
| V-B-6 | 多值分配 | 分配依据是 value 属性匹配，非位置 |
| V-B-7 | 保守判定 | 数据不足时判单值枚举，**不判 boolean** |
| V-B-8 | enum 值域完整 | `enumOptions` complete 时，enumMap 含全部选项 |
| V-B-9 | contextual 判定 | 上游联动的枚举被判为 contextual，**不静态固化** |
| V-B-10 | 跨参数回放 | 录制值 A → **不做人工修正** → 传 B 回放 → 落库为 B（**贴服务端原文**） |
| V-B-11 | derived 处置 | 派生值走依赖提取，定位方案明确并可用 |
| V-B-12 | environment 处置 | 提交时刻生成的值 → TODO + 拒绝加载，报错可读 |
| V-B-13 | 无下标取值 | grep 确认 draft 中无 `{{sN[数字].xxx}}` 形态 |

**V-B-5 / V-B-10 必须贴服务端落库原文**，不接受 HTTP 状态码作为判据。

---

## 4. 任务 C · Channel Planner

### 4.1 目标

把隐式的通道决策与 fallback，改为**显式的载体规划**。

```
当前：draft.ts 用启发式判 channel；运行时遇到失败隐式 fallback
改为：显式规划每个值的载体（carrier），载体缺失即明确失败
```

### 4.2 Carrier 模型

```ts
export interface ValueCarrier {
  /** 该值通过什么方式到达服务端 */
  via: 'network-body' | 'network-header' | 'network-url'
     | 'ui-fill' | 'ui-select' | 'ui-check' | 'ui-upload'
     | 'page-derived';   // 回放时从页面读取
  /** network 类：属于哪个步骤的请求 */
  requestStepId?: string;
  /** ui 类：操作哪个控件 */
  targetLocator?: LocatorStrategy;
}
```

**规划规则**：

```
每个参数必须有且仅有一个 carrier
规划失败（找不到载体）→ TODO_UNRESOLVED，拒绝加载
【禁止】运行时隐式改变 carrier
```

### 4.3 消灭隐式 fallback

Phase 0 已禁止「存在 merged 依赖时的 network→UI 静默降级」。Phase 2 把它规范化：

```
通道降级不再是运行时决策，而是规划期的显式分支：

若某步骤规划了 network carrier，运行时 network 失败：
  ① outcome 为 not_sent 或可证明无副作用的 confirmed_failure
     → 允许按预先规划的 ui carrier 执行
     → 但该 ui carrier 必须在规划期就存在，且其依赖的
       所有值都有对应的 ui carrier
  ② 其余 outcome → 中止（C12）

若规划期没有可用的 ui carrier → 运行时不得临时构造
```

### 4.4 文件上传

**方案：参数化为文件路径，回放用 `setInputFiles`。**

```
录制期：
  记录 filename / size / contentType 作为校验信息
  【不记录文件内容】

draft：
  参数类型 file，值为路径占位
  carrier: { via: 'ui-upload', targetLocator: ... }

回放期：
  调用方提供文件路径
  用 Playwright 的 setInputFiles 设置
  文件不存在 → 明确报错，【不得提交空表单】
  filename/size/contentType 与录制不符 → 警告但不阻断
```

**不自建 multipart**——浏览器会自然生成正确的 multipart 编码（Phase 0 的 `classifyMultipartCarrier` 已确立此方向）。

**与 Phase 0 的关系**：Phase 0 对文件型 multipart 返回 `UnsupportedMultipartError`。Phase 2 实现 `ui-upload` carrier 后，该路径应能正常工作；纯文本 multipart 的现有处理保持不变。

### 4.5 跳转型提交

```
若某 mutating 步骤后紧跟由其因果触发的导航：
  → step.expectsRedirect = true
  → 该步骤不生成 httpStatus 断言（opaque 响应拿不到）
  → 强制要求 postcondition
  → 无 postcondition → TODO，拒绝加载

expectsRedirect 的判据必须来自因果证据
（T-96 的 action/network causality、navigation lifecycle），
不得仅依据时间距离
```

**修复 Phase 1 遗留**：GLM 摸底发现 `expectsRedirect` 被错误附加到不产生导航的 fill 步骤上，导致 `waitForNavigation` 必然超时。

### 4.6 验收

| # | 项 | 期望 |
|---|---|---|
| V-C-1 | carrier 规划 | 每个参数有且仅有一个 carrier，规划失败即 TODO |
| V-C-2 | 无隐式 fallback | 运行时不再有临时构造 carrier 的路径 |
| V-C-3 | 降级需预先规划 | network 失败降级 ui 时，ui carrier 必须来自规划期 |
| V-C-4 | 文件上传 | 录制上传 → 回放传入不同文件 → 服务端收到该文件（**贴原文**） |
| V-C-5 | 文件不存在 | 路径无效 → 明确报错，**不提交空表单** |
| V-C-6 | expectsRedirect 正确性 | 仅出现在真正触发导航的 mutating 步骤上 |
| V-C-7 | 跳转型强制 postcondition | 缺 postcondition → 拒绝加载 |
| V-C-8 | merged 载体 | Phase 0 的独立回归用例保持通过；**并重跑完整 A 组场景** |

**V-C-8 的完整 A 组重跑**：Phase 0 时 A 组被参数校验先行拦截，merged 载体防线未被触发。enum 值域修好后该场景会走到 merged 防线，**必须确认它接得住**。

---

## 5. 禁止修改范围

| 禁止 | 说明 |
|---|---|
| ❌ **Phase 0 建立的任何 Safety Gate**（只能加强，不能放松） | 双重守卫、参数校验、载体校验、merged 降级禁止 |
| ❌ 删除 legacy recorder path | Phase 3 |
| ❌ 新增任何 framework 特化进 `packages/` | CI 已有防回流检查 |
| ❌ 引入 rrweb / Chrome Recorder / 新的浏览器载体 | 已裁决不做 |
| ❌ 修改 Canonical Action IR 的结构 | Phase 1 已冻结（`SemanticTarget` 采集时机除外，见 2-0-A） |
| ❌ 为让某格通过而修改 fixture 行为 | 只允许补充形态 |

---

## 6. Gate

### G-2.1 · 参数桥恢复

```
19 格中可回放格数 ≥ 12（当前 2）
参数命名无兜底类型名（除非八级全空且带 TODO）
参数与请求体绑定不再全为 TODO
```

### G-2.2 · 跨参数正确性

```
对所有可回放的格位：
  录制值 A → 不做人工修正 → 传值 B 回放
  → 服务端落库为 B

统计：跨参数正确 __ / 可回放 __
要求：不得出现「传 B 落库 A」（静默错误）
```

### G-2.3 · Safety Gate 无退化

```
Silent Wrong Success = 0
TODO_UNRESOLVED 提交次数 = 0
Phase 0 / Phase 1 全部验收项保持通过
```

### G-2.4 · 可解释性

```
每个 Skill 参数都能回答四个问题：
  source 是什么？
  representation 是什么？
  cardinality 是什么？
  carrier 是什么？

抽查 ≥10 个参数，逐个回答
```

### G-2.5 · 通用性

```
packages/* 新增 framework / fixture / endpoint specific rule = 0
（CI check-no-framework-specifics 通过）
```

---

## 7. 报告格式

```
2-0 前置小修
  A · SemanticTarget 采集时机:
    修复位置:        ______
    自变更按钮验证:  target.accessibleName = ______（期望点击前的文案）
  B · settle 拆分定级:
    复现条件:        ______
    定级:            [(a) 时序 / (b) targetKey 缺陷]
    处置:            ______

任务 A · IR 直连
  V-A-1 降级桥删除:      [是/否]，grep 引用 __ 处
  V-A-2 参数命名:        兜底命名 __ 个（期望 0 或全带 TODO）
  V-A-3 参数-请求体绑定:  全 TODO 的格位 __ 个（期望 0）
  V-A-4 可回放格数:      __ / 19（当前 2，目标 ≥12）
    未恢复的格位逐项归因:
  V-A-5 unknown 处置:    [有步骤/有 TODO/被丢弃]
  V-A-6 C5 崩溃:         [已修/未修]
  V-A-7 畸形输入:        __/5 产出 draft，未捕获异常 __ 次（期望 0）
  V-A-8 Safety Gate:     PASS / FAIL
  Shadow compare 处置:   [改为 IR 层对比 / 停用（说明理由）]

任务 B · ValueLineage
  V-B-1 ~ V-B-13:        逐项
  V-B-5 多值回放落库原文: ______
  V-B-10 跨参数落库原文:  传入=____ 落库=____
  V-B-11 derived 定位方案: [方案 a/b/c]，理由 ______

任务 C · Channel Planner
  V-C-1 ~ V-C-8:         逐项
  V-C-4 文件上传落库原文: ______
  V-C-8 A 组完整重跑:    merged 防线是否接住 ______

Gate
  G-2.1 参数桥恢复:      可回放 __/19
  G-2.2 跨参数正确性:    正确 __ / 可回放 __，静默错误 __ 次（必须 0）
  G-2.3 Safety Gate:     Silent Wrong Success=__ TODO 提交=__
  G-2.4 可解释性:        抽查 10 个参数的四问回答
  G-2.5 通用性:          CI 通过？__

回归
  unit / e2e 全量 / T68-T74+T84 / Phase0 / Phase1 验收项
  （skipped 逐项说明）

总结
  本阶段状态 / 遗留问题 / 未能完成项及原因
  是否可进入 Phase 3
```

---

## 8. 注意事项

### 8.1 不补降级桥，直接直连

`ir-downgrade.ts` 丢 `label` 导致的参数退化，**看起来补一行就能好**。不要这么做。

它是注定要删的过渡件。给它打补丁会让 IR 直连的动力消失，最后变成永久双模型——这是本项目最不能承受的债务。

**任务 A 的第一步就是删除它。**

### 8.2 参数身份来自控件，不来自值

C28 已确立，但实现时最容易犯的错是**按值去重**。

两个字段恰好录到相似的值就被合并——这正是 T-105 那个 P0 的成因（GLM 已复现：两字段同值落库 + 回放报成功）。

**默认独立，只有可靠同源证据才合并。**

### 8.3 保守方向：宁可枚举也不要布尔

数据不足判定多值时，判单值枚举而非 boolean。

```
多值误判 boolean → 静默写入错误数据（F-8：勾选「屏幕」写入「true」）
boolean 误判枚举 → 传值稍冗余（传 "on" 而非 true），行为正确
```

**后者代价远低于前者。**

### 8.4 enumOptions ≠ 静态证据

`enumOptions` 是「录制那一刻有哪些选项」的证据，**不是「这个枚举是静态的」的证据**。

contextual 判定（§3.5）必须独立进行，不能因为 `complete: true` 就静态固化。

### 8.5 服务端落库原文是唯一判据

本阶段修的正是「返回 200 但数据错误」这一类。**所有涉及数据正确性的验收，必须贴服务端查询原文。**

HTTP 状态码、回放 `ok=true`、postcondition 通过——三者都不能单独作为判据。

### 8.6 derived 的定位方案要先想清楚

GLM 报告指出纯展示元素（合计 span）的值变化**未进 `after.affected`**。

如果直接扩大 `affected` 采集范围，会带来性能与噪音成本（Phase 1 刻意限制为"值载体"是有理由的）。

**优先考虑从 `domMutations` 提取或回放时按 locator 直接读**，理由写进报告。

### 8.7 Phase 2 之后仍会有失败

Phase 2 目标是「可回放格数 ≥ 12/19」，不是 19/19。

剩余失败的合理归因包括：
- 值来源确实无法通用解决（environment 类）
- 控件形态确实需要专门支持（Phase 3 或之后）
- fixture 本身的边界情况

**每一格未恢复都要有明确归因**，不能笼统说"待后续"。

### 8.8 v2.0 约束继续有效

| 约束 | 相关 |
|---|---|
| **C2** 页面内 fetch | Channel Planner 的 network carrier |
| **C9** 浏览器侧零依赖 | 若需扩展采集能力 |
| **C11** 落盘前统一脱敏 | ValueLineage 中的值 |
| **C12** 四态 outcome | Channel 降级规则 |
| **C24** 通用化 | 全部判据必须来自 DOM/ARIA/HTTP 标准语义 |
| **C25** 用户动作可追溯 | carrier 必须对应真实交互 |
| **C27** 分析器容错 | C5 崩溃必修 |
| **C28** 参数身份来自 source lineage | 任务 B 核心 |

---

## 9. 一句话总结

> Phase 1 把捕获层修好了——**动作和状态都在 IR 里**。
> 但消费端断了：降级桥丢了 label，参数名退化成 `fill`，19 格只有 2 格能回放。
>
> Phase 2 做三件事：**让 Analyzer 直接吃 IR（删掉降级桥）**、
> **用 ValueLineage 表达值的身份与来源**、**用 Channel Planner 表达值的载体**。
>
> 判据不是"格子全绿"，是**「每个参数都能回答：它从哪来、长什么样、是单是多、怎么送到服务端」**。

---

**文档结束**
