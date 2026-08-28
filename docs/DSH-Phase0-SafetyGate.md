# DSH Browser Skill · Phase 0 · Safety Gate

版本：v1.0
日期：2026-08-28
用途：交付 Codex 执行
上游：《DSH 覆盖矩阵摸底报告》（GLM）、《通用 Web 录制回放引擎根治式重构思路》（GPT 提案）及其架构裁决
性质：**独立交付，不依赖任何重构进展**

---

## 0. T-109 / T-110 的处置【先读这一节】

### 0.1 裁决

| 任务 | 处置 | 理由 |
|---|---|---|
| **T-109**（复选语义类型推断） | **停止执行，不再收尾** | 它建立在 `packages/analyzer/src/params.ts` 的旧类型模型上，而该模型将在 Phase 2 被 `ValueLineage`（source / representation / cardinality）整体替换。继续做等于建一个后续会删掉的东西 |
| **T-110**（多值匹配 + label/value 对齐） | **不作为独立任务，内容并入本文档 0-7** | 它位于 `packages/replayer` 的 postcondition 匹配器，属于重构中的**存活层**，且独立正确 |

### 0.2 T-109 停止的额外依据

GLM 摸底观测到 T-109 进行中的状态产生了新的失败形态：

```
draft 把多值参数绑到多个单值 check 步骤
→ 回放时无法把数组值分配到各步骤
→ "参数 benefit 的值 A 无法映射为提交值"
→ 技能被标 needs_rerecord
```

**这不是实现 bug，是旧模型表达能力不足的证据。** 参数模型里没有 cardinality 概念，所以"一个多值参数对应多个单值控件"这件事无法正确表达。

在旧模型上继续修，只会得到另一个变通方案，而 Phase 2 的 `cardinality: single | multiple` 天然覆盖这个问题域。

### 0.3 工作区处置

GLM 报告显示：测试时工作区存在**未提交的 T-109/T-110 修改，且已构建进 `dist`**。

处置要求：

```
1. 先确认工作区当前状态（git status / git diff --stat）
2. 属于 T-110 范畴的改动（postcondition 匹配器、label/value 映射）
   → 保留，并入本文档 0-7 一并完成
3. 属于 T-109 范畴的改动（params.ts 类型推断、draft 步骤生成、
   多值 check 步骤分配）
   → 单独 commit 后 revert，或直接 stash 保留
   → 【不要直接 discard】：Phase 2 做 ValueLineage 时，
     这些探索的失败经验有参考价值
4. 重新构建 dist，确保与提交状态一致
5. 在报告中说明处置方式与保留位置
```

**不要在未清理工作区的情况下开始 Phase 0。** 混合状态会让本轮的验收结果无法归因。

---

## 1. 本阶段目标

### 1.1 一句话

> **`Silent Wrong Success = 0`。**
>
> 做完之后，最坏结果是「执行失败」，不再是「写错数据」。

### 1.2 为什么必须独立于重构

架构裁决已确认：DSH 将进行根治式重构（Canonical Action IR + interaction/state 捕获 + ValueLineage + 显式 Channel Planner）。

**但重构需要数周，而静默错误数据现在就在发生。**

因此 Phase 0：

- 在**当前代码库**上完成
- 独立可交付、独立可验收
- 不依赖 IR / 新 recorder 的任何进展
- **改动全部落在重构不会替换的层**（Skill 加载校验、Runtime 物化守卫、Channel 载体校验、参数校验、postcondition 匹配器）

这样 Phase 0 的成果不会被后续阶段推翻。

### 1.3 证据基础

GLM 摸底报告实证的静默错误（执行成功、无报错、数据错误）：

| # | 现象 | 证据 |
|---|---|---|
| E1 | `TODO_UNRESOLVED` 字面量被提交并落库 | C4 `contentHtml:"TODO_UNRESOLVED"`、C6 `selected:["TODO_UNRESOLVED",...]`、C8 `qty:"TODO_UNRESOLVED"`、V6 三个字段、C7、C16 `totalAmount` |
| E2 | merged + UI fallback 空值提交 | 传 `applicant="行政部-张三"` → 落库 `applicant:""`，步骤记 `confirmed_success` |
| E3 | 未声明参数被静默忽略 | C12 传 `notify:false` → 落库仍 `true`，回放报成功 |
| E4 | enum 映射失败后静默回退 | A4 传 `normal` → 落库仍 `high`；A7 传 `OPS` → 落库仍 `RD` |
| E5 | 文件上传提交空 multipart | C2/C3 落库 `files:[]`，HTTP 200 |
| E6 | 多元素数组 postcondition 恒不匹配 | F-9 |

**E1 尤其严重**：T-94 的契约明写「`TODO_UNRESOLVED` → `parseSkill()` 拒绝加载」。如果该条实现了，这些技能应在加载阶段被拒。**这个安全假设已被多轮裁决引用，必须先查清。**

---

## 2. 任务清单

### 0-1 · 查清 TODO 拒绝的实际覆盖范围【最先执行，半天】

**这是排查不是修复。** 结论出来之前不要动手改。

需要回答：

```
① parseSkill() 中是否存在 TODO_UNRESOLVED 拒绝逻辑？
   若有：位于哪个文件哪一行？

② 它检查哪些位置？
   params / body 叶子 / header / URL / query / merged 值 / multipart /
   ui.value / extract 声明 —— 逐项确认覆盖与否

③ GLM 的 harness 走库 API（generateDraft + replay）时，
   是否经过了 parseSkill？
   若绕过：replay() 的入口是否有等价校验？

④ 摸底报告中那些提交了 TODO 的格子，
   实际是走了哪条加载路径？
```

**产出**：一份简短的排查结论，说明属于以下哪种情况：

- (a) 拒绝逻辑不存在
- (b) 存在但覆盖位置不全
- (c) 存在且完整，但被库 API 绕过
- (d) 其他

**排查结论必须写进报告开头**，因为它决定后续多条护栏的设计。

---

### 0-2 · 双重守卫：加载拦截 + 运行时物化拦截

不论 0-1 的结论是哪种，都要建立**两道独立的关卡**：

```
Draft
  ↓
【关卡一】Skill 加载静态校验
  ↓
Skill 装载完成
  ↓
参数注入 / 模板物化
  ↓
【关卡二】Runtime 最终物化守卫
  ↓
发送请求 / 执行 UI 动作
```

**关卡一**（静态）：`parseSkill()` 及任何 Skill 装载入口，扫描全部可提交位置，发现 `TODO_UNRESOLVED` → 拒绝加载。

**关卡二**（运行时）：请求发出前、UI 动作执行前，对**最终物化后的实际值**再扫一次。

**为什么要两道**：GLM 的实证表明库 API 可以绕过 parser。关卡二保证**任何调用路径**都无法提交未解析值。

关卡二的位置要求：

```
network 通道：在 page.evaluate 发起 fetch 之前
UI 通道：    在 locator 执行动作之前
两者都必须在「产生副作用之前」
```

违反时的 outcome：`not_sent`（C12：请求未发出，可安全中止）。

---

### 0-3 · 拦截位置的完整覆盖

关卡一与关卡二都必须覆盖以下**全部**位置：

| 位置 | 说明 |
|---|---|
| `params[].default` | 参数默认值 |
| `network.body` 的所有叶子 | 含嵌套对象、数组元素 |
| `network.headers` 的所有值 | |
| `network.url` | 含 path 与 query |
| `ui.value` | UI 填值 |
| merged 步骤收集的值 | 它们最终进入 network body |
| multipart 的字段值与文件引用 | |
| `extract` 声明中的模板 | |
| `postcondition.match.where` 的值 | |

**实现要求**：写一个统一的递归扫描函数，被两道关卡共用，**不要写两份**。

**豁免**：`_notes`、`_correlation`、`_healHistory` 等纯诊断字段中出现 `TODO_UNRESOLVED` 是正常的，不拦截。

---

### 0-4 · 禁止 merged 依赖下的静默通道降级

**证据**（GLM A 组）：

```
参数 enum 校验拒绝 → network 步骤 not_sent
  → 引擎静默降级为 UI 点击提交
  → merged fill 步骤从不操作页面（其语义是「值合并进 network 请求」）
  → 页面输入框始终为空
  → 落库 applicant:""，步骤记 confirmed_success
```

**根本矛盾**：merged 步骤只在 network 通道下有载体。通道降级时，这些值失去载体。

**本阶段处置（保守）**：

```
network 步骤降级为 UI 之前，检查：
  该步骤是否存在 merged 依赖（有步骤的值合并进它的 body）？
    是 → 【禁止降级】
         抛 ChannelCarrierMissingError
         outcome = not_sent
         报错说明：「步骤 sN 依赖 M 个 merged 步骤的值，
                     降级为 UI 通道后这些值无载体。
                     已中止以避免提交不完整数据。」
    否 → 允许按现有安全规则降级
```

**不在本阶段做**：把 merged 步骤转成真实 UI 填值再降级。那需要 Channel Planner + Carrier 模型（Phase 2）。

**本阶段只要求：宁可失败，不要静默提交空值。**

---

### 0-5 · 参数校验失败必须报错

三类情况，当前都是静默处理，全部改为报错：

#### ① 未声明参数

```
调用方传入了技能 params 中不存在的参数
  当前：静默忽略（C12 传 notify:false 被完全忽略）
  改为：抛 UnknownParameterError
        outcome = not_sent
        报错列出：传入的未知参数名 + 技能实际声明的参数列表
```

#### ② enum 映射失败

```
调用方传入的值不在该参数的 enumMap 中
  当前：静默回退（A4 传 normal → 落库 high；A7 传 OPS → 落库 RD）
  改为：抛 EnumMappingError
        outcome = not_sent
        报错列出：传入值 + enumMap 中可用的全部键
```

**注意**：A4/A7 的根因是 enumMap 只含录制值（值域不完整）。**值域完整性是 Phase 2 的事**，本阶段只要求「映射不到就报错，不要用录制值顶替」。

#### ③ 必填参数缺失

```
required: true 的参数未传入
  改为：抛 MissingParameterError，outcome = not_sent
```

**共同要求**：三类错误都必须在**发起任何请求之前**抛出，`outcome = not_sent`。

---

### 0-6 · UI 通道的载体完整性校验

**证据**：页面输入框为空却报 `confirmed_success`。

```
UI 通道执行提交类动作（riskLevel: write/critical）之前：
  对该步骤所依赖的所有参数，确认其值已实际写入页面
    检查方式：读取对应控件的当前值，与期望值比对
    不一致或为空 → 抛 UiCarrierIncompleteError
                   outcome = not_sent
```

**范围限定**：只对 write/critical 步骤做，read 步骤不查（避免性能开销与假阳性）。

**与 T-84 的关系**：T-84 校验的是「定位到的元素对不对」，本条校验的是「值有没有写进去」。两者互补，都保留。

---

### 0-7 · postcondition 匹配器（原 T-110）

#### ① 值比较支持集合语义

```
matchesWhere 的单键比较，按形态分派：

期望数组 + 候选数组   → 集合比较（顺序无关）
期望标量 + 候选数组   → 候选集合是否包含该标量
期望数组 + 候选标量   → 期望集合是否只有一元素且等于该标量
期望标量 + 候选标量   → 字符串相等（现有逻辑）
```

**注意**：当前 `String(["SCREEN"]) === "SCREEN"` 的"恰好相等"是巧合。改造后应走"包含"分支，结果相同但语义正确。

#### ② label / value 对齐

```
比较前，若该参数存在 enumMap：
  先将期望值经 enumMap 映射为 value，再比较

映射失败：
  → 不静默跳过、不用 label 原样比较
  → postcondition 判定为无法执行
  → outcome 保持 outcome_unknown → 按现有规则中止
  → 报错：「参数 <name> 的值 <label> 无法映射为提交值，
            postcondition 无法验证」
```

#### ③ 归一化边界

```
允许：数值与其字符串形态、布尔与其字符串形态、首尾空白
禁止：大小写不敏感、模糊/包含匹配（标量比较）、类型强转宽松相等
```

**理由**：postcondition 是确认业务副作用的最后判据，宁可假阴性（多停一次）也不要假阳性（放过一次失败）。

---

## 3. 禁止修改范围

以下文件/逻辑**一行都不要改**，它们将在 Phase 1/2 被整体替换：

| 禁止修改 | 替换阶段 |
|---|---|
| `packages/locator/src/recorder-probe.ts` | Phase 1（interaction + state transition） |
| `packages/analyzer/src/params.ts` 的类型推断逻辑 | Phase 2（ValueLineage） |
| `packages/analyzer/src/draft.ts` 的 channel 判定逻辑 | Phase 2（Channel Planner） |
| `packages/replayer/src/channel-ui.ts` 的 actionability 预检 | Phase 1（Playwright 原生） |
| 任何 framework 特化路径（`.el-*` 等） | Phase 1（迁入 adapters） |

**同样禁止**：

- ❌ 新增任何控件形态支持（C4/C6/C8/C10 等一律不动）
- ❌ 修复任何"响亮失败"类问题（定位不到、超时、崩溃）
- ❌ 扩展 enum 值域（Phase 2）
- ❌ 文件上传能力（Phase 2）
- ❌ 参数命名优先级链（Phase 2）
- ❌ 引入任何新依赖

**唯一例外**：`packages/analyzer/src/draft.ts` 中若存在**生成** `TODO_UNRESOLVED` 的逻辑，允许调整其**写入位置**（确保写在会被关卡一扫到的位置），但**不得**改变生成条件。

---

## 4. Gate

Phase 0 完成的判据，三条全部满足：

### G-0.1 · Silent Wrong Success = 0

把 GLM 摸底报告中所有「传 A、落库 B、报成功」的场景重跑：

| 场景 | 当前 | Phase 0 后期望 |
|---|---|---|
| A 组 merged 空值提交 | 落库空值 + `confirmed_success` | **明确失败**（`ChannelCarrierMissingError`） |
| C12 传 `notify:false` | 被忽略，落库 `true` | **明确失败**（`UnknownParameterError`） |
| A4 传 `normal` | 落库 `high` | **明确失败**（`EnumMappingError`） |
| A7 传 `OPS` | 落库 `RD` | **明确失败**（`EnumMappingError`） |

**不要求这些场景成功，要求它们明确失败。**

### G-0.2 · TODO_UNRESOLVED 提交次数 = 0

C4 / C6 / C8 / V6 / C7 / C16 重跑：

```
服务端落库中不得出现 "TODO_UNRESOLVED" 字符串
期望行为：在加载或物化阶段被拒绝，请求根本不发出
```

**用 grep 验证**，贴出服务端全部记录的原文。

### G-0.3 · 既有验收无退化

```
unit / e2e 全量 / T68-T74+T84 / T-91~T-108 验收项
全部保持通过
```

**特别确认**：删除静默 fallback 后，此前依赖该 fallback 通过的用例若失败，**属于暴露而非退化**——这类用例要单独列出并说明，不得为了让它们变绿而恢复 fallback。

---

## 5. 报告格式

```
0-1 TODO 拒绝范围排查                    ← 最先，先出结论
  parseSkill 中是否存在拒绝逻辑:  [是/否]，位置 ______
  覆盖位置逐项:
    params:        [覆盖/未覆盖]
    body 叶子:     [覆盖/未覆盖]
    headers:       [覆盖/未覆盖]
    url/query:     [覆盖/未覆盖]
    ui.value:      [覆盖/未覆盖]
    merged 值:     [覆盖/未覆盖]
    multipart:     [覆盖/未覆盖]
    extract:       [覆盖/未覆盖]
    postcondition: [覆盖/未覆盖]
  库 API 是否绕过 parseSkill:     [是/否]
  排查结论分类:                   (a)/(b)/(c)/(d)
  摸底报告中格子实际走的路径:      ______

T-109/T-110 工作区处置
  T-110 范畴改动:  [保留并入 0-7 / 无]
  T-109 范畴改动:  [已 stash 于 ______ / 已 commit 后 revert 于 ______]
  dist 重建:       [完成/未完成]

0-2 双重守卫
  关卡一位置:      ______
  关卡二位置:      network=______ ui=______
  共用扫描函数:    ______（确认只有一份实现）

0-3 拦截位置覆盖
  九个位置逐项:    [已覆盖/未覆盖]
  诊断字段豁免:    [已实现/未实现]

0-4 merged 降级禁止
  实现位置:        ______
  错误类型:        ______

0-5 参数校验
  未声明参数:      [报错/未实现]
  enum 映射失败:   [报错/未实现]
  必填缺失:        [报错/未实现]
  三者 outcome:    ______（期望 not_sent）

0-6 UI 载体校验
  实现位置:        ______
  范围限定:        [仅 write/critical / 全部]

0-7 postcondition 匹配器
  集合语义:        [已实现/未实现]
  label→value:     [已实现/未实现]
  归一化边界:      [符合/不符合]

Gate 验证
  G-0.1 Silent Wrong Success:
    A 组 merged:   当前行为 ______（期望明确失败）
    C12:           当前行为 ______
    A4:            当前行为 ______
    A7:            当前行为 ______
    统计:          Silent Wrong Success = __（必须为 0）

  G-0.2 TODO 提交:
    C4/C6/C8/V6/C7/C16 重跑
    服务端落库 grep "TODO_UNRESOLVED":  __ 处（必须为 0）
    落库原文:      ______

  G-0.3 回归:
    unit:          __ passed / __ failed
    e2e 全量:      __ passed / __ failed / __ skipped
    T68-T74+T84:   __ passed / __ failed
    T-91~T-108:    全部保持？__
    因删除 fallback 而暴露的用例（非退化）:
      逐项列出并说明

总结
  本阶段状态 / 遗留问题 / 未能完成项及原因
  是否可进入 Phase 1
```

---

## 6. 注意事项

### 6.1 本阶段的目标是「让错误响亮」，不是「让格子变绿」

摸底报告 26 个格位只有 3 个全绿。**Phase 0 之后这个数字大概率不会变好，甚至可能变差**——因为原本"静默成功"的格子会变成"明确失败"。

**这是预期结果，不是退化。**

判据只有一个：**执行成功且数据错误的次数 = 0**。

### 6.2 不要把 Safety 修进将被替换的层

`recorder-probe.ts`、`params.ts` 的类型推断、`draft.ts` 的 channel 判定——这三处将在 Phase 1/2 被整体替换。

在这些地方做的任何修复都是白做，而且会拖慢 Phase 0 的交付。

**Phase 0 的所有改动必须落在存活层**：Skill 加载校验、Runtime 物化守卫、Channel 载体校验、参数校验、postcondition 匹配器。

### 6.3 两道关卡不能合并成一道

有一种优化的诱惑：既然关卡一已经在加载时拦了，关卡二是不是冗余？

**不是。** GLM 的实证表明库 API 调用可以绕过 parser。关卡二守的是"任何调用路径"，包括未来可能新增的入口。

**两道关卡共用扫描函数（一份实现），但调用点必须是两个。**

### 6.4 报错信息要能自解释

本阶段新增的所有错误，报错信息必须让用户知道**下一步该做什么**：

```
❌ 差的：EnumMappingError: mapping failed

✅ 好的：
参数「加急程度」的值「normal」无法映射为提交值。
该参数当前可用的值：加急
（该技能录制时只选择过「加急」，若需要其他值请重新录制）
```

**特别是 enum 映射失败**——它会因为值域不完整而频繁触发（Phase 2 才修），所以报错必须解释清楚原因，否则用户会以为是 bug。

### 6.5 v2.0 约束继续有效

本阶段特别相关：

| 约束 | 相关 |
|---|---|
| **C2** 页面内 fetch | 关卡二在 evaluate 之前 |
| **C11** 落盘前统一脱敏 | 报错信息中的值也要过 sanitize |
| **C12** 四态 outcome | 所有新增校验失败一律 `not_sent` |
| **C24** 通用化 | 校验逻辑不得出现业务字段名、框架名、端点名 |
| **C27** 分析器容错 | 本阶段不改分析器，但不得因新增校验导致崩溃 |

### 6.6 不要扩范围

发现值得做但不在本阶段的，**记录在报告「建议」段落**，标注归属 Phase 1 还是 Phase 2，不要实现。

---

## 7. 一句话总结

> Phase 0 不修任何控件、不提升任何覆盖率、不让任何格子变绿。
> 它只做一件事：**把「执行成功但数据错误」这一类，全部变成「明确失败」**。
>
> 做完之后，重构可以放心地花几周时间——因为在那几周里，最坏的结果是任务跑不通，
> 而不是有人的请假单被静默提交成了错误的数据。

---

**文档结束**
