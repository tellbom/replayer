# DSH Browser Skill · Phase 2 Dataflow 执行报告

日期：2026-08-29

分支：`codex/phase2-dataflow`

状态：**停点 ②（任务 A 已完成；19 格仅 2 格可回放，按裁决停止，任务 B/C 未开始）。**

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

## 停点 ② · 任务 A 验证

- Analyzer 通过内部 `AnalyzedAction` 证据视图直接消费 `canonicalActions`；字段为 `kind/timestamp/semanticTarget/before/after/requestIds/rawEventTypes`，没有重建 `RecordedAction` 公共兼容契约。
- `ir-downgrade.ts` 与其测试已删除，packages 中引用为 0；canonical recorder 的 `actions` 恒为空，recorder→analyzer 包依赖已删除。
- unknown/key/upload 不再因降级桥消失：证据保留；只有 raw 交互与 target 足够明确时生成 UI 动作，否则生成步骤及人工诊断说明。upload 的执行 carrier 留给任务 C。
- Phase 1 结构 shadow compare 已停用，替换为两条路径独立计数：同一标准交互 fixture 得到 legacy=4、canonical=8、unknown=2，不做结构对齐。
- build 全量通过；Analyzer 49/49；Safety unit 21/21；Phase0 Safety + 独立计数 + Phase2-0 共 4/4；constraints 全通过。
- Safety Gate：Silent Wrong Success=0；17 个失败格全部在写入前因 TODO、类型或不支持 carrier 中止，服务端落库条数均为 0。成功两格的服务端落库与传参一致。没有放宽 Safety Gate。
- 三条红线检查：未给 downgrade 打补丁；matrix fixture 四个文件与 main 原件语义 diff 为 0；Safety Gate 无退化。

### ① C5 `prompt:null` ZodError

**已修复。** Analyzer 现在清洗非字符串 `accessibleName/name/placeholder`，可选 `prompt` 不再生成 `null`。`missing target`、`accessibleName:null`、缺失 before/after、空 value、畸形 enum evidence 共 5 类 canonical 输入均产出 draft，6 个 canonical IR 测试全部通过，零 ZodError。

### ② 停点 ② 的 19 格结果与逐格归因

本轮由当前代码重新录制生成，未混用历史产物。录制 19/19、分析 19/19 均完成；原参数真实回放成功 **2/19**（C9、C12），跨参数成功 **1/19**（C9）。因为低于裁决阈值 8，任务 B/C 不得开始。

| 格位 | 当前状态 | 具体归因 |
|---|---|---|
| C1 原生多选 | 未恢复 | IR 有 select 和参数 `tags`，但数组叶 `tags[0]` 未有 cardinality/element lineage，安全门以 TODO 拒绝写入 |
| C2 单文件 | 未恢复 | upload 动作已保留；冻结 UiAction 尚无 upload 执行能力，明确报“当前任务尚未支持通道: ui” |
| C3 多文件 | 未恢复 | 同 C2，且 multiple 文件集合尚无 carrier/cardinality |
| C4 contenteditable | 未恢复 | edit 已捕获，但提交 HTML 与控件可见/文本表示不同，`contentHtml` 缺 representation 映射 |
| C5 级联选择 | 未恢复 | C5 崩溃已消失；多个 select 已保留，但数组 `localRegion` 的上下文枚举与多值 lineage 未建模 |
| C6 穿梭框 | 未恢复 | activate/check 序列可见，最终 `selected[]` 是组合派生集合，任务 A 不推断集合来源 |
| C7 树形选择 | 未恢复 | pre-action target 已正确记录；`nodes[]` 仍缺树节点多值 cardinality，第二叶被 TODO 拒绝 |
| C8 数字步进 | 未恢复 | 只有 activate，数值在 affected/domMutations；任务 A 未实施任务 B 的 derived lineage，`qty` unresolved |
| C9 滑块 | 已恢复 | 参数 `level` 原值 7 落库 `{"level":7}`，跨参数 2 落库 `{"level":2}` |
| C10 只读日期 | 未恢复 | 面板点击是 activate，提交日期是被消费的页面值；尚未建立 derived/page-value lineage |
| C11 日期区间 | 未恢复 | 两端面板点击是 activate，`startDate/endDate` 缺成对 representation/cardinality |
| C12 开关 | 已恢复（字面量） | 落库 `{"notify":true}`；未形成参数，false 跨参数尚不可验证 |
| C13 标签输入 | 未恢复 | edit/activate 序列存在，但 tags 数组缺多值分配，`tags[0]` 被 TODO 拒绝 |
| C14 搜索型下拉 | 未恢复 | 搜索参数已识别；最终 `approverId` 来自响应选项值，尚缺 response-value lineage |
| C15 表格内联编辑 | 未恢复 | edit 参数仍为兜底名 `edit_4`，动态行 `items[0].qty` 的行/字段 lineage 未建立 |
| C16 动态增删行 | 未恢复 | 六个 edit 可见；数组行归属与 derived `totalAmount` 未建模，安全门拒绝 |
| B1 复选多值 | 未恢复 | 两个 check 被建成两个 boolean 参数，回放传 array 触发类型错误；需要任务 B cardinality |
| V6 environment | 未恢复 | title 已参数化；提交时环境生成 `requestId` 无可重现来源，按安全规则保持 TODO 并拒绝 |
| A 组 merged | 未恢复 | 基础参数已恢复；`center` 等跨表示/派生叶尚无 lineage，写请求被 TODO 安全门拒绝 |

### ③ 跨参数正确性的服务端落库原文

任务 A 中唯一成功的跨参数格 C9 已取得服务端落库原文：录制/原参数传入 7，服务端 `parsed={"level":7}`；不人工修正 draft，跨参数传入 2，服务端 `parsed={"level":2}`。其余跨参数正确性仍须等任务 B；HTTP 200 未被当成成功证据。

## 后续硬门槛

已命中 `< 8` 停止条件，当前不得进入 ValueLineage 或 Channel Planner。继续前需要评审“任务 A 直连后仍为 2/19”的根因：多数格位并非 IR 未直连，而是明确依赖任务 B 的 representation/cardinality/derived/response lineage；C2/C3 则依赖任务 C 的 upload carrier。
