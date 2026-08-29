# DSH Browser Skill · Phase 2 Dataflow 执行报告

日期：2026-08-29

分支：`codex/phase2-dataflow`

状态：**停点 ①（2-0 前置小修完成）；任务 A/B/C 尚未开始。**

## 2-0 前置小修

### A · SemanticTarget 采集时机

- 修复位置：`packages/locator/src/canonical-recorder-probe.ts`。
- RED 证据：按钮点击前 `aria-label="＋ 华东"`，点击处理器同步改为 `－ 华东`；Phase 1 代码记录的 `target.accessibleName` 实际为 `－ 华东`。
- 修复：创建 `PendingAction` 时与 `before` 同时采集并冻结 `semanticTargetAtStart`；settle 后只采集 `after` 与 mutation evidence。provisional/final emit 和 T-96 active action 均复用冻结身份。
- GREEN 证据：同一用例记录 `target.accessibleName="＋ 华东"`，页面 settle 后实际按钮为 `－ 华东`。
- IR 契约：未增加或修改 CanonicalAction/SemanticTarget 公共字段，只修正采集时机。

### B · settle 拆分定级

- 复现条件：同一 `#save` Button Element 先发生 `pointerdown`，跨过 30ms 测试 settle 边界后再发生 `pointerup + click`。
- RED 原文：产生两个 action；第一个 `raw.eventTypes=["pointerdown"]`，第二个 `raw.eventTypes=["pointerup","click"]`。
- targetKey 稳定性：两段来自同一个 Element；DOM、tag、name、type、form/container 和 peer index 均未变化，生成 target 也同为 `button/Save`。因此不是 targetKey 缺陷。
- 定级：**(a) 偶发时序边界问题**。
- 处置：新增具名常量 `CANONICAL_CAPTURE.pointerMergeGraceMs=250`。仅当最近关闭动作来自同一 Element、targetKey 相同、仍是不完整 pointer 序列时续接原 actionIdx；完整 click 后的新 pointerdown 不满足续接条件。
- GREEN 原文：动作数 1，`raw.eventTypes=["pointerdown","pointerup","click"]`。
- legacy 边界：`git diff -- packages/locator/src/recorder-probe.ts` 为 0 行。

## 停点 ① 验证

| 检查 | 结果 |
|---|---|
| Phase 2-0 两条浏览器回归 | 2/2 PASS |
| Phase 1 shadow + T95 导航/异常容灾 | 3/3 PASS |
| T-74 异步联动 | 2/2 PASS |
| Canonical + Phase 0 safety unit | 16/16 PASS |
| core / locator / recorder build | PASS |
| `npm run check:constraints` | PASS |
| 本停点变更文件 ESLint | PASS，0 error |
| legacy recorder diff | 0 行 |

## 三项强制回答（当前停点状态）

### ① C5 `prompt:null` ZodError

**尚未修复。** 它属于下一步任务 A 的硬性验收 V-A-6，不归为范围外问题。任务 A 必须先写 canonical malformed-input RED 用例，再修到“产出 draft、保留步骤/诊断、零未捕获异常”。

### ② 当前 19 格未恢复归因基线

任务 A 尚未执行，因此当前仍沿用 Phase 1 Gate 的 2/19 基线；以下是进入任务 A 前的逐格具体归因，不代表 Phase 2 最终结果：

| 格位 | 当前状态 | 具体归因 |
|---|---|---|
| C1 原生多选 | 未恢复 | Canonical 多选状态经 downgrade 后与请求数组叶子的参数绑定断裂 |
| C2 单文件 | 未恢复 | upload 在 downgrade 中被丢弃，且尚无 ui-upload carrier |
| C3 多文件 | 未恢复 | 同 C2；还需要 multiple file 路径与控件 carrier |
| C4 contenteditable | 未恢复 | edit 已捕获，但 accessibleName/state 未被旧 Analyzer 直接消费，body 仍 unresolved |
| C5 级联选择 | 未恢复/崩溃 | 空 label/prompt 进入旧参数 schema，抛 `prompt:null` ZodError |
| C6 穿梭框 | 未恢复 | 非按钮 activate 已捕获，但旧 Analyzer 不消费其累积选择状态 |
| C7 树形选择 | 未恢复 | 原 target 取 after 文案且选择值绑定断裂；target 时机已在本停点修复，绑定待任务 A/B |
| C8 数字步进 | 未恢复 | 值只存在于 `after.affected/domMutations`，旧 Analyzer 不消费 |
| C9 滑块 | 已恢复 | Phase 1 Gate 已验证录制值与跨参数值均正确 |
| C10 只读日期 | 未恢复 | activate/after.value 已捕获，旧 Analyzer 未从 Canonical state 建参数与 carrier |
| C11 日期区间 | 未恢复 | 两个日期来源与请求叶子映射未由 IR 直连表达 |
| C12 开关 | 已恢复（字面量） | 当前仅字面量路径可回放；参数化 false 仍待 ValueLineage |
| C13 标签输入 | 未恢复 | 多 action/数组值未形成 cardinality 与请求数组绑定 |
| C14 搜索型下拉 | 未恢复 | 响应值链与后续请求叶子关系在旧桥后变为 unresolved |
| C15 表格内联编辑 | 未恢复 | 动态元素 edit 已捕获，但旧 Analyzer 未直接消费其 target/state lineage |
| C16 动态增删行 | 未恢复 | 六个 action 可见，但数组 lineage、字段分组及 derived total 尚未建模 |
| B1 复选多值 | 未恢复 | downgrade 把多值 enum 退化为 boolean，缺 cardinality/value 分配 |
| V6 environment | 未恢复 | DOM 不可读的提交时生成值没有可重现来源，按 Phase 2 应明确 unresolved 并拒绝 |
| A 组 merged | 未恢复 | enum 修复前参数校验先拦截；尚未进入完整 merged carrier 防线复验 |

### ③ 跨参数正确性的服务端落库原文

**本停点未进行任务 A/B 的跨参数回放，因此尚无新的服务端落库记录。** 当前只确认捕获层修复不触发业务提交。任务 B 验收 V-B-5/V-B-10 必须记录“录制 A、draft 零人工修改、传 B 回放”后的服务端查询 JSON；HTTP 状态与 `ok=true` 不作为证据。

## 后续硬门槛

下一步只执行任务 A（Analyzer IR 直连、删除 downgrade、C5 容错）。完成后重跑 19 格并报告可回放数；若 `< 8`，停止并逐格分析，不进入 ValueLineage 或 Channel Planner。
