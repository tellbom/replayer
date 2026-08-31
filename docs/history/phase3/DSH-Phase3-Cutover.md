# DSH Browser Skill · Phase 3 · Cutover

版本：v1.0
日期：2026-08-30
用途：**交付 Codex 执行**（开发任务）
上游：Phase 2 通过（执行报告 `846c4dc`，分支 `codex/phase2-dataflow`）
后续：Phase 3 完成后由 GLM 做最终 Gate 验证

---

## 0. 交付对象与分支策略

| 角色 | 职责 |
|---|---|
| **Codex** | 执行本文档全部任务 |
| **GLM** | Phase 3 完成后做最终 Gate 验证 |
| 裁决 | 评估后决定是否可用于内网试点 |

### 0.1 分支处置

Phase 2 在隔离 worktree `codex/phase2-dataflow` 完成。**Phase 3 开始前需要先决定合并时机。**

```
建议：Phase 3 在同一分支继续，全部完成后一次性合并
理由：Phase 3 包含大量删除，中途合并会让主分支处于半删状态
```

若主检出区的未提交内容需要先处理，**请先提出，不要自行操作用户的工作区**。

---

## 1. 本阶段目标

### 1.1 一句话

> **切默认路径、删除 legacy、消除双模型，让系统只剩一条执行链路。**

### 1.2 当前的双模型状态

Phase 1/2 期间刻意保留了两套并行的东西，现在到了清理的时候：

| 保留物 | 保留理由 | 现在的状态 |
|---|---|---|
| `legacy` recorder path | Phase 1 shadow compare 的对照基线 | 使命完成 |
| `el-form-item` / `el-option` / `el-dialog-scoped` / `el-table-cell` 四个 strategy | 解析历史 skill | 测试数据全部可废弃，无存量需求 |
| shadow compare 相关代码 | Phase 1 Gate 判据 | Phase 2 已停用降级桥，它已不完整 |
| `RecordSession.actions` 字段 | legacy 路径产物 | legacy 删除后无用 |
| `recorderPath` 开关 | 路径切换 | 只剩一条路径后无意义 |

### 1.3 删除的前提是最后一次对照

**不能直接删。** 删除前必须做一次完整对照，证明 legacy 已无独有能力。

这是 Phase 3 的第一个任务（3-1），也是唯一的硬门。

---

## 2. 3-1 · 删除前的最后一次对照【硬门，先做】

### 2.1 为什么需要

Phase 1 的 shadow compare 依赖降级桥，Phase 2 已删除该桥。**当前没有任何机制能验证 legacy 是否还有 canonical 拿不到的能力。**

GLM 在 Phase 1 Gate 中做过真实 Element Plus 系统的三方对比，结论是「新 legacy 未被削弱，canonical 额外捕获三类交互」。**但那是三个月前的代码状态**，Phase 2 改动了 Analyzer 全链路。

### 2.2 对照方法

**不做结构对齐**（降级桥已删），改为**能力对照**：

```
在完整 matrix fixture（19 格）+ 至少一个真实系统上：

① legacy 路径录制 → 统计捕获的动作
② canonical 路径录制 → 统计捕获的动作
③ 逐格对比：legacy 捕获到而 canonical 没有的动作
```

**判据**：

```
legacy 独有动作 = 0        → 通过，可删
legacy 独有动作 > 0        → 逐项分析：
    a. canonical 应该捕获但漏了 → 【停止】，修复后重测
    b. legacy 的"捕获"实际是误报（如把非交互当动作）→ 记录，可删
    c. 其他 → 【停止】等裁决
```

### 2.3 真实系统对照

**必须包含至少一个真实系统**，不能只在 fixture 上做。

GLM 在 Phase 1 用过 `replayer-web-test`（Vue3 + Element Plus 2.8.8 的 OA 靶场，开发模式实例）。若该环境仍可用，用它；若不可用，说明原因并只用 fixture，**但要在报告中明确标注这一限制**。

Phase 1 的真实系统对照曾发现三类 legacy 零捕获的交互（日期面板点击、radio、自定义 div 下拉）——**这类证据 fixture 给不了**。

### 2.4 产出

```
逐格对照表：
| 格位 | legacy 动作数 | canonical 动作数 | legacy 独有 | 独有项归因 |

真实系统对照表（同上结构）

结论：legacy 是否存在独有能力
```

---

## 3. 3-2 · 切换默认路径

### 3.1 交付

```
① recorderPath 默认值改为 canonical（若尚未）
② --recorder-path legacy 保留但输出弃用警告：
   「legacy 录制路径将在下一版本移除，建议使用默认路径。
     若你因某种原因必须使用 legacy，请反馈原因。」
③ 文档中所有涉及路径选择的说明改为「默认即可，无需指定」
```

### 3.2 观察期

**建议但不强制**：切默认后跑一轮完整回归再删除，确认没有隐藏依赖。

若时间允许，3-2 和 3-3 之间留一次完整 E2E。

---

## 4. 3-3 · 删除 legacy recorder path

### 4.1 删除清单

| 删除对象 | 位置 |
|---|---|
| legacy recorder probe | `packages/locator/src/recorder-probe.ts` |
| legacy probe 的构建产物 | `dist/recorder-probe.iife.js` 及构建配置中的对应条目 |
| `recorderPath` 开关与相关分支 | `packages/recorder/src/session.ts` 等 |
| `RecordSession.actions` 字段 | `packages/core/src/types.ts` |
| legacy 专属测试 | 对应 spec 文件 |
| shadow compare 相关代码 | `captureLegacy` / `captureCanonical` 辅助、shadow spec |
| Phase 1 的 legacy 回退构建脚本 | GLM 的 `tmp/phase1-gate/` 下产物（若已进仓库） |

### 4.2 需要注意的三处

**① `RecordSession.actions` 删除会影响什么**

它是 v2.0 冻结契约的一部分。删除属于契约变更，但：

```
测试数据全部可废弃，无存量 record.json 需要解析
canonical 路径下该字段已不填充（Phase 2 起）
→ 删除是安全的
```

**在报告中明确记录这是一次契约变更。**

**② shadow compare 删除后的替代**

Phase 3 之后不再有对照机制。这是可以接受的（只剩一条路径，无从对照），但：

```
要确认 3-1 的对照结果已经归档
它是"legacy 无独有能力"的唯一证据，删除后无法复现
```

**③ 不要顺手删 `settleNavigation` 等通用能力**

`packages/locator/` 下有些能力是 Phase 1 从 `el-locator` 重写来的通用实现（`selectOption` / `setDateTime` / `inDialog` / `tableRowButton` 等），**它们不是 legacy，不要误删**。

删除前确认每个文件的归属：

```
legacy recorder path 相关 → 删
Phase 1 重写的通用能力   → 保留
```

---

## 5. 3-4 · 删除 `el-*` 遗留

### 5.1 删除清单

```
① packages/core/src/types.ts 中四个 @deprecated strategy 的类型定义
   - el-form-item
   - el-option
   - el-dialog-scoped
   - el-table-cell

② packages/core/src/schema.ts 中对应的 zod 分支

③ 任何解析这些 strategy 的运行时代码

④ CI check-no-framework-specifics 的 @deprecated 豁免规则
   （删除后不再需要豁免）
```

### 5.2 删除后的验证

```
① CI framework 检查在无豁免规则下通过
② 全库 grep 无 el-* / ant-* / arco-* 残留（vendor 与 adapters 除外）
③ adapters/ 仍为空（Phase 1 的成果，不应有回流）
```

### 5.3 `adapters/` 目录的处置

Phase 1 建立时预期是"目标为空"，实际结果确实为空（只有 `.gitkeep`）。

**裁决：保留空目录 + `.gitkeep` + README**

README 内容要求：

```markdown
# adapters/

此目录用于存放确实无法用 DOM/ARIA/HTTP 标准语义表达的框架适配代码。

**当前为空，这是预期状态。**

Phase 1 的全库盘点证明：所有框架特化能力（浮层挂 body、
遮罩动画等待、日期面板操作等）都能用标准语义重写，
无一需要依赖框架私有 class。

若将来确需新增 adapter，必须：
① 说明为什么无法用标准语义表达
② core 不得 import 它
③ adapter 只能增加证据，不能绕过任何 core invariant
④ adapter 失效时 core 走通用路径降级，不崩
⑤ 不得影响 Safety Gate
```

**保留空目录的理由**：它是一个明确的信号——"这里本来可以放框架特化，但我们没有需要放的"。删掉目录，这个信息就没了，将来有人可能直接把框架代码写回 `packages/`。

---

## 6. 3-5 · Phase 2 遗留的两项

### 6.1 merged 载体防线的完整链路验证【必做】

**背景**：该防线至今没有在真实链路上被触发过。

| 阶段 | 状态 |
|---|---|
| Phase 0 | 被参数校验先行拦截，防线未触发 |
| Phase 2 | 被 `UnresolvedValueError` 先行拦截，防线未触发 |
| 现有证据 | 独立构造的用例证明防线本身有效 |

两道防线都在、先触发的那道更早更安全——**这不是缺陷**。但如果将来某次改动让前面的防线失效，merged 是最后一道，而它从没在真实链路上验证过。

**要求**：构造一个完整场景：

```
条件：
  · 所有参数合法（不被参数校验拦截）
  · 无 TODO_UNRESOLVED（不被加载期守卫拦截）
  · network 步骤存在 merged 依赖
  · network 步骤失败且 outcome 为 not_sent

期望：
  · 抛 ChannelCarrierMissingError
  · 请求发送数 = 0
  · 服务端落库 = 0
  · 不发生 UI 降级提交
```

**构造提示**：Phase 2 报告指出 A 组的 `center` 因缺少 `研发中心 ↔ RD` 的映射证据而 TODO。若补一次录制让该映射有证据（例如从 DOM option value 或响应数据中取得），参数校验就不会先拦，链路能走到 merged 那一步。

**这一项若无法构造出来，说明防线在当前架构下不可达**——那也是有价值的结论，如实报告即可，不要勉强构造。

### 6.2 展示节点观测范围【决策项，非必做】

**背景**：C16 因录制期 `captureObservableElements()` 只观测"值载体"，合计 `<span>` 未进 `domMutations`，Analyzer 拿不到 locator。

**这是一个有代价的决策，不是 bug**：

| 方案 | 收益 | 代价 |
|---|---|---|
| 扩大观测到展示节点 | C16 类 derived 值可用 | 性能开销、数据量、噪音、PII 面扩大 |
| 保持现状 | 无新代价 | derived 展示值明确不支持 |

**Phase 3 的处置**：

```
不做实现，只做评估：
① 估算扩大观测的代价（数据量增幅、性能影响）
② 评估收益（真实系统中有多少此类值）
③ 给出建议，写进报告
④ 【不实现】——留给 Phase 3 之后决策
```

**若评估显示代价很小**（例如只需在 mutation 中额外记录 textContent 变化，且能通过"该值出现在后续请求体中"过滤噪音），可以提议在 Phase 3 之后单独立项。

---

## 7. 3-6 · 文档与交付物收敛

### 7.1 需要更新的文档

| 文档 | 更新内容 |
|---|---|
| `README.md` | 移除 legacy 路径说明；标准流程只剩一条 |
| `docs/skill-authoring.md` | 已有 V6 不支持边界；补 derived 判定边界、C16 类限制 |
| `docs/DSH-Phase0-SafetyGate.md` | 已有 Silent Wrong Success 定义；确认最终状态 |
| 设计文档 | derived 判定边界（`value` = 用户输入 / `textContent` = 页面派生） |
| **新增：架构总览** | 见 7.2 |

### 7.2 架构总览文档【新增，重要】

Phase 0–3 跨越多个月，产生了大量分散的裁决与约束。**需要一份收敛的总览**，否则后续接手者要读十几份文档才能理解现状。

要求包含：

```
① 一条完整链路的说明
   录制 → IR → 分析 → ValueLineage → Channel Planner → 回放
   每一层的职责边界

② 约束清单 C1–C28 的现状
   哪些仍然有效、哪些已被后续裁决取代、哪些因架构变更而不再适用

③ 明确不支持的边界清单
   · 提交时刻由前端生成的值（时间戳/UUID/设备标识）
   · 无定位证据的展示节点派生值
   · 其他 Phase 2/3 确认的边界

④ 三条不可让步的原则
   · 分类只打标签，永不用于决定是否记录
   · 参数身份来自 source lineage，不来自值
   · Silent Wrong Success 恒为 0（含验证方式定义）

⑤ CI 守卫清单
   framework-specific 检查、package boundary、safety 约束
   各自防的是什么

⑥ 长期回归样本
   C9（简单数值参数化）、C14（跨表示映射）
   以及它们为什么不能删
```

**这份文档的读者是"三个月后接手的人"**，写作时假设他没读过任何历史文档。

### 7.3 历史文档归档

Phase 0–3 期间的任务文档、执行报告、验证报告数量众多。

```
建议：docs/history/ 下按阶段归档
保留：架构总览、skill-authoring、Phase0 SafetyGate（作为长期判据）
归档：各阶段的任务书与执行报告
```

**不要删除历史文档**——它们记录了"为什么这么设计"，而那些理由在总览里往往只剩结论。

---

## 8. 禁止事项

| 禁止 | 说明 |
|---|---|
| ❌ 在 3-1 对照未通过时删除 legacy | 唯一的硬门 |
| ❌ 放松任何 Safety Gate | Silent Wrong Success 恒为 0 |
| ❌ 顺手实现展示节点观测（6.2） | 只评估不实现 |
| ❌ 新增 framework 特化 | CI 已防回流 |
| ❌ 删除 Phase 1 重写的通用能力 | 它们不是 legacy |
| ❌ 删除 `adapters/` 目录 | 保留空目录 + README，见 5.3 |
| ❌ 删除长期回归样本 C9 / C14 | Phase 2 已标记 |
| ❌ 自行操作用户主工作区的未提交内容 | 需要处理时先提出 |

---

## 9. Gate

### G-3.1 · legacy 无独有能力

```
3-1 的对照结果：legacy 独有动作 = 0
或所有独有项归因为「legacy 误报」并逐项说明
```

### G-3.2 · 单一路径

```
recorderPath 开关已删除
RecordSession.actions 字段已删除
shadow compare 相关代码已删除
全库 grep 无 legacy recorder 引用
```

### G-3.3 · 框架残留清零

```
四个 el-* strategy 类型定义已删除
CI framework 检查在无豁免规则下通过
全库 grep 无框架类名残留（vendor 除外）
adapters/ 为空（仅 .gitkeep + README）
```

### G-3.4 · Safety Gate 无退化

```
Silent Wrong Success = 0
TODO_UNRESOLVED 提交 = 0
16/19 可回放格位保持，逐字段落库验证通过
C9 / C14 长期回归通过
```

### G-3.5 · merged 防线

```
完整链路验证通过
或明确说明「在当前架构下不可达」及理由
```

### G-3.6 · 文档收敛

```
架构总览文档完成，包含 7.2 的六项
不支持边界清单明确
历史文档已归档
```

---

## 10. 报告格式

```
3-1 删除前对照                          ← 硬门
  fixture 对照（19 格）:
    | 格位 | legacy | canonical | legacy 独有 | 归因 |
  真实系统对照:
    环境: ______（若不可用，说明原因）
    | 交互 | legacy | canonical | legacy 独有 |
  结论: legacy 独有动作 = __（期望 0）
  若 > 0: 逐项归因

3-2 默认路径切换
  默认值:            ______
  弃用警告:          [已加/未加]
  观察期回归:        [已跑/未跑]

3-3 legacy 删除
  删除清单逐项:      [已删/保留（说明）]
  RecordSession.actions 契约变更:  [已记录]
  误删检查:          Phase 1 重写的通用能力 [完整保留]
  全库 grep legacy 引用:  __ 处（期望 0）

3-4 el-* 遗留删除
  四个 strategy:     [已删/保留]
  CI 豁免规则:       [已删/保留]
  全库 grep:         __ 处（期望 0，vendor/adapters 除外）
  adapters/ 状态:    [空 + README / 有内容（说明）]

3-5 Phase 2 遗留
  merged 完整链路:   [验证通过 / 不可达（理由）]
    若通过: 请求数=__ 落库=__ 错误类型=______
  展示节点评估:      
    代价估算:        ______
    收益评估:        ______
    建议:            ______
    【确认未实现】

3-6 文档
  架构总览:          [完成/未完成]，六项覆盖情况
  不支持边界清单:    ______
  历史归档:          [完成/未完成]

Gate
  G-3.1 legacy 无独有:    PASS / FAIL
  G-3.2 单一路径:         PASS / FAIL
  G-3.3 框架清零:         PASS / FAIL
  G-3.4 Safety Gate:      Silent Wrong Success=__ 可回放=__/19
  G-3.5 merged 防线:      PASS / 不可达
  G-3.6 文档:             PASS / FAIL

回归
  build / unit / e2e 全量 / matrix / C9-C14 长期回归 / constraints
  （skipped 逐项说明）

总结
  本阶段状态 / 遗留问题
  是否可用于内网试点
```

---

## 11. 注意事项

### 11.1 3-1 是唯一的硬门

删除是不可逆的。**对照没做完不要删。**

Phase 1 的 shadow compare 已因降级桥删除而失效，3-1 是最后一次能证明"legacy 无独有能力"的机会。**证据必须归档**，删除后无法复现。

### 11.2 真实系统对照不能省

fixture 是自己造的，它的形态反映的是"我们以为真实系统长什么样"。

Phase 1 的真实系统对照曾发现三类 legacy 零捕获的交互——**那些是 fixture 给不了的证据**。

若真实环境确实不可用，如实标注限制，**不要用 fixture 结果冒充完整对照**。

### 11.3 删除时最容易犯的错是误删通用能力

Phase 1 把 `el-locator` 的九个方法全部重写成了通用实现（用 `role=listbox`、`role=dialog`、标准 IDL setter 等），这些**不是 legacy**。

删除前逐文件确认归属，**宁可多留一个待确认，也不要误删**。

### 11.4 展示节点只评估不实现

6.2 看起来"顺手就能做"，但它涉及数据量、性能、PII 面三方面代价。

Phase 1 刻意把观测限制为"值载体"是有理由的。**要改这个决定，应该基于评估数据单独立项，不是在 Cutover 阶段顺手加。**

### 11.5 架构总览是给三个月后的人写的

Phase 0–3 产生了十几份文档、28 条约束、多次裁决修正。

**接手者不应该需要读完全部才能理解现状。** 总览要能独立成立——读完它就知道系统怎么工作、边界在哪、什么不能碰。

写作时假设读者没读过任何历史文档。

### 11.6 v2.0 约束的现状要盘点

C1–C28 中，有些已被后续裁决取代或因架构变更而不再适用。例如：

```
C24（通用化）→ 仍有效，且已由 CI 强制
C25（用户动作可追溯）→ 仍有效
C28（参数身份来自 source lineage）→ Phase 2 已落地
某些针对旧架构的约束 → 可能已不适用
```

**逐条盘点，写进架构总览。** 留着不适用的约束会误导后续开发。

---

## 12. 一句话总结

> Phase 0 让错误变响亮，Phase 1 让捕获变通用，Phase 2 让值有身份。
> Phase 3 做的是**减法**：删掉为过渡而保留的一切，让系统只剩一条路径。
>
> 唯一的硬门是 3-1——**删除前的最后一次对照**。
> 它是"legacy 已无独有能力"的唯一证据，删完就再也拿不到了。

---

**文档结束**
