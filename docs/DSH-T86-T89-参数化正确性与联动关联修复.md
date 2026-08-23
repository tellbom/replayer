# DSH Browser Skill · T-86 ~ T-89 · 参数化正确性与联动关联修复

版本：v1.0
日期：2026-08-21
用途：交付 Codex 连续执行，全部完成后一次性提交报告
上游：《T-85 Network 通道健康审计报告》
关联规格：《DSH Recorder 开发执行规格 v2.0》约束 C1–C23；T-79~T-84 产品裁决

---

## 0. 本轮定位

T-85 审计确认 network 通道**执行层健康**（C2 fetch、跨步模板、Outcome 四态、依赖识别均完好），退化集中在**分析器的参数化与关联逻辑**。

本轮修复四项，其中 T-86 是 P0，因为它会造成静默错单。

**执行方式**：T-86 → T-87 → T-88 → T-89 连续执行，**不需要中间停顿评审**，全部完成后提交一份合并报告。

**但有两个例外必须停下**（见 §5.3）：
- T-86 的核心验收（V-86-2）若无法通过，停止，不要继续 T-87
- 任何修复需要修改 v2.0 冻结契约时，停止，先提出

---

## 1. T-86 · 参数化正确性修复【P0】

### 1.1 问题描述

T-85 审计中，自动生成的 draft 出现：

```yaml
type: "{{s4[0].value}}"
```

`s4` 是 `GET /api/overtime/types` 的响应。这个模板的实际含义是：**不管调用方传什么参数，永远提交类型列表的第一项**。

### 1.2 为什么这是 P0

推演后果：

| 调用参数 | approver 步骤提交 | submit 步骤提交 | Mock 校验 | 结果 |
|---|---|---|---|---|
| `type=工作日加班` | 列表第一项 = workday | workday | 三者一致 | 200 ✅ 恰好正确 |
| `type=周末加班` | 列表第一项 = **workday** | **workday** | **三者仍自洽** | **200 ✅ 但提交错了** |

**用户申请周末加班，系统提交工作日加班，全流程零报错。**

这与 T-84 防范的语义漂移是同一类问题（静默错单），但更严重：
- T-84 的漂移需要页面改版才触发
- 本问题**第一次跨参数调用就是错的**
- 且 approver 与 submit 用同一错误模板，导致服务端校验**无法发现**（两边都错得一致）

### 1.3 为什么 T-85 没测出来

T-85 报告 E 步原文：

> 本次自动 draft 不是无需复核即可直接回放的成品，因此**使用仓库中同一流程的已修正技能**执行周末参数回放

**E 步测的是人工修正后的技能，不是分析器的产物。** 所以：
- "依赖识别正确"的结论只覆盖 `approverId` / `approvalToken`
- **`type` 的参数化从未被验证**
- 分析器在跨参数场景下的真实表现是未知的

这正是 T-30 DoD 所警告的升级版：不能靠「原参数原样回放成功」证明正确，**也不能靠「人工修正后的技能回放成功」证明分析器正确**。

### 1.4 修复要求

#### R1 · enum 参数必须绑定调用方参数

分析器生成 draft 时，对于识别为 `type: enum` 的参数：

```yaml
# ❌ 禁止
type: "{{s4[0].value}}"        # 从响应数组取固定下标
type: "workday"                 # 硬编码录制时的值
type: "{{s4.list[0].value}}"    # 任何形式的响应取值

# ✅ 要求
type: "{{type|enumValue}}"      # 绑定到 params 中声明的参数
```

`enumValue` 过滤器负责 label → value 映射（`工作日加班` → `workday`），映射表来源：
- 优先：录制时从页面选项收集的 label/value 对（已在 T-31 参数候选标注中采集）
- 其次：从 `GET .../types` 响应中提取，**但作为静态映射表写入 draft，不是运行时下标取值**

映射表写入 draft 的形态：

```yaml
params:
  - name: type
    type: enum
    required: true
    enumMap:                     # 【新增】静态映射，非运行时取值
      工作日加班: workday
      周末加班: weekend
      节假日加班: holiday
```

#### R2 · 未被引用的参数必须报错

draft 生成完成后执行静态检查：

```
对 params 中每个声明的参数 P：
  扫描所有 step 的 network.body / network.url / network.headers / ui.value
  若无任何位置出现 {{P}} 或 {{P|filter}}
    → 抛 UnusedParameterError
    → 报错信息：
      「参数 'type' 已声明但未被任何步骤引用。
        这通常意味着参数化失败——该值可能被硬编码或从响应中取值。
        请检查步骤 s5、s9 的 body。」
```

**这条护栏能拦住整类问题**，不只是当前这一个。

#### R3 · 响应取值的合法边界

不是所有 `{{sN.xxx}}` 都是错的。区分：

| 形态 | 合法性 | 说明 |
|---|---|---|
| `{{s2.approverId}}` | ✅ 合法 | 跨步依赖：服务端生成的动态值，必须从响应取 |
| `{{s2.approvalToken}}` | ✅ 合法 | 同上 |
| `{{s4[0].value}}` | ❌ 禁止 | 数组下标取值，与调用方参数无关 |
| `{{s4.list[0].value}}` | ❌ 禁止 | 同上 |
| `{{type\|enumValue}}` | ✅ 合法 | 绑定调用方参数 |

**判定规则**：模板中出现 `[数字]` 下标的响应取值，一律拒绝生成，改为参数绑定或报错。

理由：数组下标取值意味着"取固定位置的那一项"，这个位置与调用方意图无关，本质上就是硬编码。

#### R4 · 报错优于静默生成

当分析器无法确定某个字段应该绑定哪个参数时：

```yaml
# ✅ 正确做法
type: "TODO_UNRESOLVED"
# TODO: 无法自动确定此字段的参数来源。
# 录制时值为「工作日加班」，疑似对应参数 type。
# 请手动改为 {{type|enumValue}} 或确认正确来源。
```

同时 `parseSkill()` 遇到 `TODO_UNRESOLVED` **直接拒绝加载**，强制人工处理。

**禁止**：为了让 draft "看起来完整"而生成一个能跑但语义错误的模板。

### 1.5 验收

#### V-86-1 · enum 参数正确绑定

```
1. 录制 type=工作日加班 的加班流程
2. dsh analyze 生成 draft
3. 检查 draft 中 approver 与 submit 两个步骤的 type 字段
```

**期望**：均为 `{{type|enumValue}}`，且 `params.type.enumMap` 含三个映射项。
**禁止出现**：`{{s4[0].value}}`、`workday` 硬编码、任何 `[数字]` 下标。

#### V-86-2 · 跨参数回放【本轮最关键的验收】

```
1. 录制 type=工作日加班
2. dsh analyze 生成 draft
3. 【不做任何人工修正】
4. dsh replay 传入 type=周末加班
```

**三种可能结果的判定**：

| 结果 | 判定 |
|---|---|
| 成功，且服务端记录的 type 确为 `weekend` | ✅ **PASS** |
| 被 Mock 拒绝（400，approver 不匹配） | ⚠️ 部分通过——参数绑定对了但依赖链有问题，记录并排查 |
| **成功，但服务端记录的 type 是 `workday`** | ❌ **FAIL，本轮核心失败** |

**必须验证服务端实际记录的值**，不能只看 HTTP 200：

```bash
curl -s '.../api/overtime/history?limit=1' | grep weekend
```

**若 V-86-2 未通过，停止，不要继续 T-87。** 这是本轮的存在理由。

#### V-86-3 · 未引用参数报错

```
构造一个 draft，params 声明了 reason 但所有步骤都硬编码了事由文本
→ 期望：生成阶段抛 UnusedParameterError，不产出 draft 文件
```

#### V-86-4 · 下标取值被拒绝

```
构造分析器输入，使其倾向于生成 {{sN[0].xxx}}
→ 期望：改为参数绑定，或生成 TODO_UNRESOLVED
→ 期望：不产出任何含 [数字] 下标的模板
```

#### V-86-5 · 合法跨步依赖不受影响

```
→ 期望：{{s2.approverId}} 与 {{s2.approvalToken}} 仍正常生成
→ 期望：T-85 E 步的反例对照仍成立
   （weekend + workday 的 approverId/token → 400）
```

---

## 2. T-87 · 联动关联改用 DOM 因果【P1】

### 2.1 问题描述

T-85 审计发现 `approver` 请求被关联到了错误的动作：

```
选择工作日加班  ts=437251
开始时间        ts=437388   (+137ms)
结束时间        ts=437500   (+112ms)
事由 fill       ts=437619   (+119ms)
approver 请求   ts=437756   (+137ms)   ← 距真正触发它的动作 505ms
```

「最近前置动作 + 2 秒窗口」算法把它归给了「事由 fill」。

### 2.2 根因不是窗口太小

Mock 的 `loadApprover` 内有 `await sleep(500)`（坑点 K10，故意的异步延迟）。只要**联动延迟 > 后续操作间隔**，时间窗归属必然出错。

内网系统更慢，这个问题会更常见，**调大窗口只会引入更多误归属**（把无关请求也吸进来）。

### 2.3 修复方向：用 DOM 因果代替时间猜测

T-70 已实现 DOM 变更观测器（`__DSH_MUTATION__`）。它能观测到「选择动作后，审批人字段从空变非空」——**这是因果关系，不是时间巧合**。

#### 关联优先级（新）

```
对每个 mutating 请求 R：
  1. 【DOM 因果】若某动作 A 的 appearedRoots / 字段变更中，
     包含了 R 响应体里的值（如 approverName「李总监」出现在页面上）
       → R 归属 A，置信度 high
  2. 【网络因果】若 R 的请求体中含某动作 A 的输入值
     （如 approver 请求体 {type:'workday'} 含 A 选择的值）
       → R 归属 A，置信度 high
  3. 【时间窗兜底】现有的最近前置动作 + 2 秒窗口
       → 置信度 low，且必须在 draft 中打 TODO 标记
```

**要点**：第 2 条尤其便宜——`POST /api/overtime/approver` 的 body 是 `{type: 'workday'}`，而「选择加班类型」这个动作的 value 就是 `工作日加班`（经 enumMap 映射为 `workday`）。**值匹配即因果**，不需要 DOM 观测就能定案。

建议先实现第 2 条（成本最低），再补第 1 条。

#### 置信度必须落文

```yaml
- id: s9
  desc: 加载审批人
  channel: network
  _correlation:                    # 【新增，诊断用，回放时忽略】
    method: request-value-match    # dom-causality | request-value-match | time-window
    confidence: high               # high | low
    ownerAction: s4
    evidence: "请求体 type=workday 匹配步骤 s4 的选择值"
```

时间窗兜底（`confidence: low`）时，draft 必须打 TODO：

```yaml
# TODO: 此请求的归属由时间窗推断（置信度低）。
# 距最近前置动作 505ms，可能实际由更早的动作触发。
# 请确认它是否应归属于 s4「选择加班类型」。
```

### 2.4 验收

#### V-87-1 · 值匹配关联

```
录制加班流程（脚本化，动作间隔 < 200ms，联动延迟 500ms）
→ 期望 approver 归属 s4「选择加班类型」，不是「事由 fill」
→ 期望 _correlation.method = 'request-value-match'
→ 期望 _correlation.confidence = 'high'
```

#### V-87-2 · 时间窗兜底仍可用

```
构造一个无值匹配、无 DOM 变更的请求（如埋点后的业务 GET）
→ 期望仍能按时间窗归属
→ 期望 confidence = 'low' 且 draft 中有 TODO
```

#### V-87-3 · 人工节奏录制

```
录制时人为放慢（每个动作间隔 > 1.5s）
→ 期望 approver 仍正确归属 s4
→ 证明修复对两种节奏都有效
```

#### V-87-4 · 回归

T-85 中通过的 `correlate` 8 个单测全部保持通过。

---

## 3. T-88 · sanitizeMode 语义澄清与 drop_response 直连验证【P2】

### 3.1 sanitizeMode 部分

T-85 发现 `/api/session` 与 `/api/csrf` 两条 GET 的 `sanitizeMode` 为 `fallback`。

**先判定性质，再决定是否修**：

```
检查这两条请求的 fallback 来源：
  ├─ 因为 GET 无 postData，走了「无 body 时的默认标记」
  │    → 这是标记语义问题，不是脱敏缺陷
  │    → 修法：无 body 时应标 'none' 而非 'fallback'
  └─ 因为响应体解析失败而降级到整串正则
       → 这是真缺陷
       → 修法：排查 content-type 传递或 JSON 解析逻辑
```

**必须先在报告中明确是哪一种，再动手。**

同时澄清 T-24 DoD 的适用范围：原文限定为 `approver` 与 `submit` 两条**参与依赖识别**的请求必须为 `structured`。不参与依赖识别的请求（session/csrf）不在此列。

T-85 报告将其记为"不符"是自行加严了，**但加严的方向是对的**——修完之后把 DoD 正式扩展为：

> 所有含 body 的请求 `sanitizeMode` 必须为 `structured`；无 body 的请求标记为 `none`；出现 `fallback` 即为解析逻辑未覆盖，须修复而非放行。

### 3.2 drop_response 直连验证部分

T-85 G 步记录：

> 当前 Vite proxy 将后端断连表征为 `HTTP 500 + 空响应体`，不是浏览器侧 `status=null`

**这意味着 T-37 机械规则的关键分支从未被验证。**

设计意图是：`fetchStarted=true` 且 `status === null` → **无条件** `outcome_unknown`。现在测到的是另一条路径（`status=500` → 判 unknown）。

**真正的"连接断开"路径是防重复提交的核心**，必须单独验证。

#### 修复要求

```
1. 增加一种绕开 Vite proxy 的测试模式：
   e2e 中直接以后端地址为 origin 执行 network 步骤
   （或在 Mock 中提供一个不经 proxy 的端口）
2. 在该模式下触发 drop_response=1
3. 断言：
   - 浏览器侧 fetch 抛异常，status === null
   - outcome = 'outcome_unknown'
   - 走的是 status===null 分支（加日志或返回字段标识）
   - submissions delta = 1
   - 未发生自动 UI fallback
```

#### V-88-1 ~ V-88-3

| # | 验收 | 期望 |
|---|---|---|
| V-88-1 | sanitizeMode 性质判定 | 报告中明确是标记问题还是解析缺陷 |
| V-88-2 | 修复后分布 | 含 body 请求全 `structured`，无 body 请求 `none`，`fallback` 为 0 |
| V-88-3 | drop_response 直连 | `status === null` 分支被实际执行，`submissions` delta = 1 |

---

## 4. T-89 · 审计入口可执行化【P2】

T-85 发现文档中的审计命令在本仓库无法执行：

```
pnpm ... → ERROR This project is configured to use npm
jq ...   → 命令不存在（Windows）
```

审计者用等价命令绕过了，但**下次审计仍会踩同样的坑**。

### 交付

`scripts/audit/` 目录，包含跨平台可执行的审计脚本：

```
scripts/audit/
├── network-health.mjs      # T-85 全部审计项，Node 实现，无需 jq
├── channel-distribution.mjs
├── dependency-trap.mjs     # 跨参数回放验证
└── README.md               # 每个脚本的用途与判读方法
```

要求：
- 纯 Node 实现，不依赖 `jq` / `grep` / 特定 shell
- 用 `npm run audit:network` 之类的 npm script 暴露
- 输出格式与 T-85 报告的字段一一对应，可直接粘贴
- Windows / macOS / Linux 均可运行

**这一项不阻塞其他任务**，可最后做。

---

## 5. 执行要求

### 5.1 提交方式

- 每个任务独立 commit：`fix(T-86): ...`、`fix(T-87): ...`
- T-86 的契约变更（`enumMap`、`_correlation`）与实现可分 commit，但在同一 PR
- **不需要中间停顿评审**，四个任务连续执行

### 5.2 全部完成后的报告格式

```
T-86 参数化正确性
  V-86-1 enum 绑定:        PASS / FAIL
    draft 中 type 字段实际值: ______
    enumMap 映射项数:        __
  V-86-2 跨参数回放:        PASS / 部分 / FAIL   ← 本轮核心
    replay 结果:            成功 / 400 拒绝
    服务端记录的 type:       ______   ← 必须贴实际查询结果
    history 查询原文:        ______
  V-86-3 未引用参数报错:    PASS / FAIL
  V-86-4 下标取值被拒:      PASS / FAIL
  V-86-5 跨步依赖回归:      PASS / FAIL

T-87 联动关联
  V-87-1 值匹配关联:        PASS / FAIL
    approver 归属:          s__ (期望 s4)
    _correlation.method:    ______
    _correlation.confidence: ______
  V-87-2 时间窗兜底:        PASS / FAIL
  V-87-3 人工节奏:          PASS / FAIL
  V-87-4 correlate 回归:    __ passed / __ failed

T-88 sanitizeMode 与 drop_response
  V-88-1 性质判定:          标记问题 / 解析缺陷
    判定依据:               ______
  V-88-2 修复后分布:        structured=__ none=__ fallback=__
  V-88-3 直连 drop_response: PASS / FAIL
    status 实际值:          ______ (期望 null)
    走的分支:               ______
    submissions delta:      __

T-89 审计脚本
  跨平台验证:               ______
  npm script 可用:          [是/否]

回归
  unit:                     __ passed / __ failed
  e2e:                      __ passed / __ failed / __ skipped
  T68-T74 + T84:            __ passed / __ failed

总结
  本轮状态:                 ______
  遗留问题:                 ______
  未能修复的项及原因:        ______
```

### 5.3 必须停下的两种情况

1. **V-86-2 未通过** → 停止，不要继续 T-87。这是本轮的存在理由，跳过它做后面的没有意义。
2. **修复需要修改 v2.0 冻结契约**（第二部分的类型定义）→ 停止，先提出变更提案，等确认。
   - 注意：本文档已明确允许新增 `params.enumMap` 与 `step._correlation`，这两项**不算**契约破坏，可直接实现
   - 其余任何 Schema 改动都需要先提

---

## 6. 注意事项（重要，请逐条核对）

### 6.1 不要用"能跑通"证明"是对的"

这是本轮修复的直接教训。T-85 的 E 步用人工修正过的技能回放成功，就得出了"依赖识别正确"的结论——但分析器产出的 draft 从未被跨参数测试过。

**要求**：
- 所有关于分析器正确性的结论，**必须用分析器的直接产物验证**，不得用人工修正后的版本
- V-86-2 明确写了「不做任何人工修正」，这四个字是验收的核心

### 6.2 HTTP 200 不等于业务正确

`{{s4[0].value}}` 这个 bug 的可怕之处在于：approver 和 submit 用同一个错误模板，导致服务端校验**两边都错得一致**，返回 200。

**要求**：
- 涉及业务正确性的验收，**必须查询服务端实际记录的数据**，不得只断言 HTTP 状态码
- V-86-2 明确要求贴 `history` 查询原文

### 6.3 静默正确比静默错误更危险

一个永远提交列表第一项的技能，在"恰好第一项就是想要的"场景下会一直正确，直到某天不是——而且不会报错。

**要求**：
- 修复时优先考虑"错了能否被发现"，而不只是"能否修对"
- R2（未引用参数报错）、R4（报错优于静默生成）都是这个思路，请务必实现，不要因为"当前用例已经修好了"而跳过

### 6.4 不要调大时间窗来"修"关联问题

T-87 的问题看起来调大窗口就能解决，但那会引入更多误归属——把无关请求也吸进来。

**要求**：
- 用因果关系（值匹配、DOM 变更）代替时间猜测
- 时间窗只作为兜底，且必须标 `confidence: low` + TODO
- **禁止**把 2 秒窗口改成 5 秒或更大来通过测试

### 6.5 T-79~T-84 的产品裁决全部有效

本轮不改变任何定位器相关裁决：

- Playwright 单引擎（T-83 已完成）
- LOW 合法，允许生成、允许执行
- 不新增框架特化（Element UI/Plus、Ant Design 等）
- 不使用 XPath、DOM similarity、sibling scoring、visual locator
- 不依赖 LLM
- T-84 的语义漂移防护继续有效

**本轮只动分析器的参数化与关联逻辑，不碰定位层。**

### 6.6 v2.0 约束继续有效

特别相关的几条：

| 约束 | 本轮相关性 |
|---|---|
| **C1** | channel 是步骤级属性 —— 修复不得改为技能级 |
| **C2** | network 步骤必须在 `page.evaluate` 内 fetch —— T-85 已确认完好，不得破坏 |
| **C12** | 写操作四态 —— T-88 的 drop_response 验证直接相关 |
| **C15** | 关联用 requestTs 不用 responseTs —— T-87 修改关联逻辑时必须保持 |
| **C11** | 落盘前统一脱敏 —— T-88 修 sanitizeMode 时不得绕开 `sanitize.ts` |

### 6.7 报告要求诚实

- 未通过的项如实标 FAIL，**不得**改测试或降低断言使其变绿
- 跳过的测试单列并说明原因，不计入通过
- 若某项修复后仍有残留问题，明确写出，不要含糊为"基本正常"
- 若发现本文档的要求有误或不可实现，**说明理由并停下来问**，不要自行调整需求

### 6.8 不要顺手扩范围

本轮**禁止**新增：

- LLM 相关能力（包括增强 heal）
- 新的定位策略
- 新的 session / 认证能力
- MCP 相关实现
- 自动改版迁移
- 任何 T-79 §12 禁止清单中的内容

发现值得做的事情，**记录在报告的"建议"段落**，不要在本轮实现。

---

## 7. 一句话总结

> `{{s4[0].value}}` 让系统在用户申请周末加班时静默提交工作日加班，且服务端校验无法发现。
> 本轮的核心是让**分析器的直接产物**能通过跨参数验证，而不是让**人工修正后的技能**能跑通。
> 验收的四个字是：**不做任何人工修正**。

---

**文档结束**
