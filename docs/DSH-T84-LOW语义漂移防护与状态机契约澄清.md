# DSH Browser Skill · T-84 · LOW 语义漂移防护与状态机契约澄清

版本：v1.0
日期：2026-08-21
用途：交付 Codex 开发
上游：《DSH-T79-T83-Playwright 单引擎 Cutover 与用户验收交互节点 v1.0》
关联规格：《DSH Recorder 开发执行规格 v2.0 完整版》约束 C1–C23

---

## 0. 本任务要解决什么

T-79~T-83 的产品裁决是正确的，本任务**不改变任何裁决**，只补一个会造成业务错单的缺口。

### 缺口描述

把 T-79 文档的三条串起来：

1. **§13 V8** 明确接受「页面变化后 nth 仍唯一但语义已错位」为产品限制
2. **§6** verified 后 LOW 允许无监督自动运行
3. 本系统提交的是**请假单、加班单、报销单**等真实业务单据

**合并后果**：某次前端改版后，`getByRole('textbox').nth(5)` 从「开始时间」漂移到「结束时间」，Skill 照常运行，不报错，提交一张字段错位的单据。用户可能数月后才发现。

这与 v2.0 架构中 C12（ExecutionOutcome 四态）、C6（写操作确认）所防范的是同一类问题：**静默的错误比失败更危险**。

### 解法

`recordedHint.visibleText` 在 T-79 §2 中已经要求录制并存储，当前仅用于「提示、日志、首次验证和诊断」。

**本任务将其升级为 LOW 步骤的执行前置断言。**

这不是 DOM similarity、不是 sibling scoring、不是 framework detection、不是 XPath、不是 visual locator——**是一次字符串比对，数据源是已有字段**。不违反 T-79 §12 的任何一条禁令。

---

## 1. 与 T-79~T-83 的关系

| 项 | 状态 |
|---|---|
| T-79 全部产品裁决（§0 十条） | **不变** |
| Playwright 单引擎 Cutover | **不变** |
| LOW 合法性 | **不变**，LOW 仍然允许生成、允许执行 |
| 不新增框架特化 | **不变**，本任务不引入任何 `if ElementPlus` 类判断 |
| 不依赖 LLM | **不变**，本任务零 LLM 参与 |
| §12 禁止扩范围清单 | **全部继续有效** |
| §13 V8 测试 | **拆分为 V8-a / V8-b**，见 §5 |
| `recordedHint` 用途 | **扩展**：从「仅提示」到「LOW 步骤前置断言」 |

**执行顺序**：T-84 应在 T-80 完成后、T-82 GO/NO-GO 之前执行。T-82 的验收报告需包含本任务的结果。

---

## 2. 契约变更

### 2.1 `recordedHint` 结构正式化

当前 T-79 §2 给出的形态：

```yaml
confidence: LOW
recordedHint:
  action: fill
  visibleText: 开始时间
```

正式化为：

```ts
export const RecordedHintSchema = z.object({
  /** 录制时的动作类型 */
  action: z.enum(['click','fill','select','check','datetime','navigate']),

  /**
   * 录制时该元素的可见语义文本。
   * 取值优先级（取第一个非空）：
   *   1. accessible name（Playwright 的 accessible name 计算结果）
   *   2. 关联 <label> 的文本内容
   *   3. aria-label / aria-labelledby 指向的文本
   *   4. placeholder
   *   5. title
   *   6. 元素自身可见文本（截断 60 字符）
   * 全部为空时置 null，该步骤不做语义断言（见 §3.4）
   */
  visibleText: z.string().nullable(),

  /** visibleText 的来源，用于诊断与回放期同源比对 */
  visibleTextSource: z.enum([
    'accessible-name','label','aria','placeholder','title','text','none'
  ]),

  /** 录制时的元素标签名与 role，作为辅助校验 */
  tagName: z.string(),
  role: z.string().nullable(),

  /** 录制时该 locator 的匹配数量，用于诊断 */
  matchCountAtRecord: z.number(),
});
```

**要求**：
- `visibleText` 的提取必须在**浏览器侧**完成（遵守 C9：零依赖、零 Node API）
- 提取逻辑必须**录制与回放同源**，即调用同一个函数，避免两侧算法不一致造成假阳性
- 提取函数放在 `packages/locator/src/`，导出供两侧使用

### 2.2 Skill 状态机补充字段

在 T-81 已定义的字段基础上追加：

```ts
export const SkillVerificationSchema = z.object({
  status: z.enum(['draft','verified','needs_rerecord']).default('draft'),
  requiresFirstRunVerification: z.boolean().default(false),
  verifiedAt: z.string().nullable().default(null),
  verifiedRunId: z.string().nullable().default(null),
  verifiedBy: z.string().nullable().default(null),

  /** 【T-84 新增】verified 有效期，超期回落 draft */
  verifiedTtlDays: z.number().default(30),

  /** 【T-84 新增】被标记 needs_rerecord 的原因，供用户诊断 */
  rerecordReason: z.object({
    at: z.string(),
    stepId: z.string(),
    kind: z.enum([
      'not-found',            // 0 match
      'strict-multiple',      // 多匹配
      'semantic-drift',       // 【T-84 核心】nth 唯一但语义已变
      'scope-missing',        // scope/dialog 不存在
      'frame-missing',
      'action-failed',
    ]),
    detail: z.string(),
  }).nullable().default(null),
});
```

### 2.3 Step 层无需新增字段

`recordedHint` 挂在 step 的 ui 段内即可，沿用 T-79 §2 的位置。

---

## 3. 实现要求

### 3.1 LOW 步骤的执行前置断言

**仅对 `confidence: LOW` 的步骤生效。HIGH 步骤不做此断言**（HIGH 本身就是语义锚点，重复校验无意义且会引入假阳性）。

执行流程：

```
LOW 步骤执行前：
  1. 按 locator 定位
     ├─ matchCount === 0        → 停止，needs_rerecord(kind='not-found')
     ├─ matchCount > 1          → 停止，needs_rerecord(kind='strict-multiple')
     │                             【禁止 .first()，沿用 T-79 §6】
     └─ matchCount === 1        → 继续
  2. recordedHint.visibleText === null
     → 跳过语义断言，直接执行（见 §3.4）
  3. 用同源函数提取当前元素的 visibleText
  4. 归一化比对（见 §3.3）
     ├─ 匹配   → 执行该步骤
     └─ 不匹配 → 停止
                 status = needs_rerecord
                 rerecordReason.kind = 'semantic-drift'
                 rerecordReason.detail =
                   `步骤 ${stepId}：录制时此处为「${录制值}」，当前为「${当前值}」`
```

### 3.2 报错信息必须可读

面向用户的输出，不要只丢一个 error code：

```text
✗ 执行中止：步骤 4（填写）

  录制时，此位置的控件是：开始时间
  现在，此位置的控件是：  结束时间

  该步骤使用位置型定位（getByRole('textbox').nth(5)），
  页面结构变化后指向了不同的控件。

  为避免提交错误数据，已停止执行。
  该 Skill 已标记为需要重新录制。
```

### 3.3 归一化比对规则

比对前双方都做以下归一化，避免无意义的假阳性：

```
1. trim 首尾空白
2. 全角转半角
3. 移除标点：: ： * ？ ? 及连续空白折叠为单个空格
4. 移除常见必填标记：开头或结尾的 * 与 ＊
5. 大小写不敏感（英文场景）
```

**不做**：模糊匹配、编辑距离、同义词。**归一化后必须完全相等**。宁可假阳性（多停一次）也不要假阴性（放过一次错位）。

假阳性的代价是用户重录一次；假阴性的代价是一张错误单据。

### 3.4 无语义文本时的行为

若录制时 `visibleText` 就是 null（元素确实没有任何可提取的语义），该步骤：

- 跳过语义断言（无可比对基准）
- 在 Recorder 完成界面**单独标注**：

```text
步骤 7
动作：点击
录制提示：（该控件无可识别文本）
Locator：getByRole('button').nth(3)

风险：
该步骤依赖控件顺序，且无语义可校验。
页面结构变化时无法自动检测错位。
```

- 计入 §4 的高风险统计

### 3.5 verified 失效条件

`verified` 不是永久状态。以下任一条件触发即回落 `draft`：

| 条件 | 动作 |
|---|---|
| `verifiedAt` 距今超过 `verifiedTtlDays`（默认 30 天） | → `draft`，需重新监督一次 |
| 任一 LOW 步骤触发 `semantic-drift` | → `needs_rerecord`（不是 draft，因为结构已确认变化） |
| 任一步骤触发 not-found / strict-multiple / scope-missing | → `needs_rerecord` |

**注意**：`semantic-drift` 直接进 `needs_rerecord` 而非 `draft`——因为已经证明页面结构变了，重新监督一次也没用，必须重录。

TTL 到期回落 `draft` 时，向用户说明：

```text
此 Skill 上次验证于 2026-07-20（32 天前）。
包含 2 个位置型定位步骤，建议重新监督运行一次。
```

### 3.6 `needs_rerecord` 之后的处置

- **禁止自动执行**。任何调用尝试执行 `needs_rerecord` 状态的 Skill，必须直接拒绝并提示重录
- **文件保留，不删除**。用户重录时可对比新旧，也便于排查是页面变了还是当初录错了
- 重录产出的新 Skill 覆盖同 id 时，旧版本按现有版本机制保留

---

## 4. Recorder 完成界面补充

在 T-79 §4 已有输出的基础上追加两项。

### 4.1 LOW 占比警告

```text
Skill：提交加班申请
共 12 个步骤
稳定定位：10
位置型定位：2  (17%)
```

当 LOW 占比 ≥ 50% 时，追加警告（**仅提醒，不阻止**）：

```text
⚠ 此 Skill 中 11/12 步为位置型定位（92%）。

  该页面缺乏语义结构，Skill 稳定性较低，
  页面任何改动都可能导致步骤错位。

  建议：确认目标页面是否有更适合录制的入口，
        或联系该系统维护方为关键控件补充 label / aria-label。
```

### 4.2 无语义步骤单独统计

```text
位置型定位：2
  其中可语义校验：1
  其中无法校验：1  ← 页面变化时无法检测错位
```

---

## 5. 测试要求

### 5.1 V8 拆分（替换 T-79 §13 的 V8）

原 V8 描述的场景实际包含两种，必须拆开：

#### V8-a · nth 漂移到语义不同的控件【新增，必须停止】

```
构造：
  1. 录制一个 LOW 步骤，目标为「开始时间」输入框，
     产物 getByRole('textbox').nth(5)，recordedHint.visibleText = '开始时间'
  2. 修改页面：在该控件之前插入一个新的输入框
  3. 此时 nth(5) 指向「结束时间」，matchCount 仍为 1
  4. 回放

期望：
  - 执行中止，不填写任何内容
  - status = needs_rerecord
  - rerecordReason.kind = 'semantic-drift'
  - rerecordReason.detail 同时包含「开始时间」与「结束时间」
  - 若该 Skill 后续有提交步骤，submissions 数量必须为 0
```

**`submissions === 0` 是本测试最关键的断言**——证明错位被拦在提交之前。

#### V8-b · nth 漂移到语义相同的控件【保留原意，Accepted product limitation】

```
构造：
  1. 同上录制
  2. 修改页面，使 nth(5) 指向另一个可见文本同为「开始时间」的控件
     （例如页面新增了一个同名字段的区块）
  3. 回放

期望：
  - 执行继续（语义断言无法区分）
  - 测试断言：记录为 Accepted product limitation
  - 测试注释必须写明：
    「本测试不要求自动发现。语义文本相同时无法区分，
      属已接受的产品限制。禁止后续将本测试扩展为自愈任务。」
```

**保留 T-79 原意**：用测试固化产品边界，防止后续 Agent 把它扩成复杂自愈。

### 5.2 新增测试

| # | 场景 | 期望 |
|---|---|---|
| V9 | LOW 步骤语义未变 | 正常执行，不误报 |
| V10 | 归一化边界：录制「事由：」，回放「事由 *」 | 归一化后相等，**不得**误报 |
| V11 | 归一化边界：录制「开始时间」，回放「开始 时间」 | 折叠空白后相等，不得误报 |
| V12 | `visibleText` 为 null 的步骤 | 跳过断言正常执行；Recorder 界面单独标注 |
| V13 | HIGH 步骤不做语义断言 | 即使 accessible name 有细微变化也不误停 |
| V14 | `verifiedTtlDays` 到期 | status 自动回落 draft，提示重新监督 |
| V15 | `needs_rerecord` 状态下尝试执行 | 直接拒绝，不启动浏览器 |
| V16 | 录制与回放的 visibleText 提取同源 | 同一元素两侧提取结果完全一致 |
| V17 | LOW 占比 ≥ 50% | Recorder 输出警告文案，但**不阻止**保存 |

### 5.3 回归要求

- T-79 §13 的 V1–V7 全部保持通过
- T-80 重跑的 T68/T69/T70/T71/T72/T73/T74 全部保持通过

> **注意**：T-79 §8 的重跑清单遗漏了 **T-70（DOM 变更观测器）**。T-71 的 scope 推导依赖 T-70，只跑 T-71 不跑 T-70 逻辑不完整。本任务的回归清单已补上，T-82 的报告也应包含。

---

## 6. 契约澄清（必须写入文档与代码注释）

以下三条在 T-79 中未明确，Codex 极易理解偏，必须显式落文。

### 6.1 `verified` 与 C6 的关系

> **`verified` 只免除「首次全流程人工监督」，不免除 C6 的写操作逐步确认。**
>
> 两者是独立的安全层：
> - **首次验证**：确认这个 Skill 的每一步定位是否正确（一次性）
> - **C6 写确认**：确认这一次执行的参数是否正确（每次）
>
> 一个 verified 的 Skill，其 `riskLevel: write/critical` 步骤**仍然**需要执行前确认。

**❌ 禁止**：把 `verified` 实现成「全自动免确认」。

### 6.2 `verified` 与 `needs_rerecord` 的转换方向

```
draft ──(监督运行 + 用户确认正确)──> verified
draft ──(监督运行 + 用户发现错误)──> draft（保持，提供重录入口）

verified ──(TTL 到期)──────────────> draft
verified ──(semantic-drift)────────> needs_rerecord
verified ──(not-found/multiple/…)──> needs_rerecord
draft    ──(结构失败)──────────────> needs_rerecord

needs_rerecord ──(重新录制)────────> draft（新录制产物）
needs_rerecord ──(任何自动尝试)────> 拒绝执行
```

**没有** `needs_rerecord → verified` 的直接路径。必须经过重录。

### 6.3 本任务与「不新增框架特化」的关系

> `visibleText` 的提取使用 **accessible name 计算 / label 关联 / aria / placeholder** 这些 **W3C 标准语义**，不依赖任何前端框架的类名或 DOM 结构约定。
>
> **禁止**在提取逻辑中出现：
> ```
> if (el.closest('.el-form-item')) ...
> if (className.includes('ant-form-item')) ...
> ```
>
> 若某框架的控件恰好无法提取到语义文本（如 Element Plus 的 `el-form-item__label` 无 `for` 关联），**接受 `visibleText: null`**，走 §3.4 的降级路径。**不得**为此新增框架适配。

这条是 T-79 §12 的直接延续。

---

## 7. 禁止清单（本任务专属）

在 T-79 §12 全部禁令继续有效的前提下，本任务额外禁止：

| ❌ 禁止 | 原因 |
|---|---|
| 用模糊匹配 / 编辑距离 / 同义词做语义比对 | 假阴性会放过真实错位；宁可多停一次 |
| 在 visibleText 提取中引入框架类名判断 | 违反 §6.3 与 T-79 §12 |
| 语义断言失败时尝试自动寻找正确元素 | 那是自愈，本轮明确不做 |
| 为通过 V8-b 而扩展比对维度（位置、兄弟、结构） | V8-b 是已接受的产品限制，不是待解决问题 |
| 对 HIGH 步骤也施加语义断言 | 会引入假阳性且无收益 |
| 把 `verified` 实现为免除写操作确认 | 违反 C6 |
| 语义断言失败时降级为警告继续执行 | 必须硬停。这是本任务存在的全部意义 |

---

## 8. 交付与提交要求

1. **单独 commit**，message 前缀 `feat(T-84):`
2. 契约变更（§2）与实现（§3）可分两个 commit，但必须在同一 PR
3. 文档更新：
   - T-79 文档的 §2 追加「recordedHint 同时用作 LOW 步骤前置断言，详见 T-84」
   - T-79 文档的 §13 V8 标注「已由 T-84 拆分为 V8-a / V8-b」
   - **不修改 T-79 的任何产品裁决文字**
4. T-82 的最终报告格式（T-79 §14）追加以下行：

```text
LOW steps:            _ / _  (__%)
  可语义校验:         _
  无法校验:           _

T-84 语义漂移防护:
  V8-a (漂移到不同语义):  PASS / FAIL
  V8-b (漂移到相同语义):  Accepted product limitation
  V9-V17:                 PASS / FAIL
  假阳性次数:             _   ← 归一化规则是否过严的指标
```

---

## 9. 执行顺序与停止点

```
T-79 (已完成)
   ↓
T-80 Playwright 默认 Cutover
   ↓
T-84 本任务  ← 插入位置
   ↓
T-81 首次人工验证状态机
   ↓
T-82 GO/NO-GO 闸门（报告须含 T-84 结果）
   ↓
T-83 删除 legacy（仅 GO 时）
```

**说明**：T-84 放在 T-81 之前，因为 §2.2 的状态机字段（`verifiedTtlDays`、`rerecordReason`）需要在 T-81 实现状态机时一并落地，避免 T-81 做完再返工。

若实现时发现 T-84 与 T-81 耦合过紧难以拆分，允许合并为一个 PR，但 commit 必须分开且 message 分别标注 T-81 / T-84。

**停止点**：T-84 完成后停下汇报，等确认后再进入 T-81。

---

## 10. 一句话总结

> LOW 定位是被接受的产品形态，但**位置漂移导致的静默错单不是**。
> 用已经录到的 `visibleText` 做一次字符串比对，把"必然静默"变成"响亮失败"，
> 代价是偶尔多停一次让用户重录——这个代价远小于一张错误的业务单据。

---

**文档结束**
