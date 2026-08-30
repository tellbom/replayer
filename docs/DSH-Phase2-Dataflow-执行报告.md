# DSH Browser Skill · Phase 2 Dataflow 执行报告

日期：2026-08-30

分支：`codex/phase2-dataflow`

状态：Phase 2 已通过，可进入 Phase 3（Cutover）。

## 1. 2-0 与任务 A

- SemanticTarget 在交互起点与 before-state 同时冻结；自改名按钮记录点击前名称 `＋ 华东`。
- settle 拆分定级为同一 Element、同一 targetKey 的时序边界；`pointerMergeGraceMs=250` 后原始序列为 `pointerdown,pointerup,click`。
- Analyzer 直接消费 Canonical IR；`ir-downgrade.ts` 已删除且无引用；canonical recorder 不再生成 legacy actions。
- C5 `prompt:null` 已修：五类畸形输入均不抛 ZodError。
- legacy recorder 路径未修改；独立计数 legacy=4、canonical=8、unknown=2，不做结构降级对齐。

## 2. C8/C11 静默成功缺陷与修复

### 2.1 C11 独立归因

C11 不是 attribute/IDL 读取错误，也不是提取发生在写值之前：录制的 `after.self.value` 和 `domMutations.after.value` 均为 `2026-09-18`，运行期读取代码也是 `element.value`。

实际链路有两层缺陷：

1. Analyzer 把标准表单 IDL `value` 的用户选择误判为 page-derived；
2. 全局 `networkPrimary` 规则压掉了产生该值的非提交 UI 动作，因此提交前从第二个输入框读到空串。

修复采用 DOM/数据流通用判据：因果 mutation 的 `after` 含标准 IDL `value` 时，该值属于用户输入来源并使用显式 network carrier；只有非表单 DOM 状态（例如展示节点 `textContent`）才可成为 page-derived。该规则不含 fixture、字段、端点或框架判断。

### 2.2 page-derived 双层处置

- 新 draft 的 derived 值写入 `internalValues`，不进入调用方可见 `params`。
- 物化值写入 `context.vars`，不修改 `context.params`。
- 旧 skill/手工编辑若仍传入同名值，读取页面实际值后抛 `DerivedParameterOverrideError`，outcome 为 `not_sent`；错误列出参数名、调用值 A、页面值 B，请求发送次数为 0。
- C8 重新识别为公共 `qty` 参数；C11 重新识别为公共 `startDate/endDate` 参数。

修复后：C8 传 `5/9` 分别落库 `{"qty":5}` / `{"qty":9}`；C11 两组日期均逐字段一致，见 §4.1。

## 3. 等价覆盖隐患审计

| 候选 | 原状态 | 处置/结论 |
|---|---|---|
| preflight 提取值 | `resolveTemplate` 原先优先读取 params；同名时存在遮蔽风险 | `parseSkill` 加载期拒绝 params 与 preflight/internalValues 同名 |
| `{{sN.xxx}}` 跨步依赖 | params 原先可占用实际作为路径根使用的步骤 id，理论上可遮蔽 stepResults | 加载期拒绝 params 与被 `{{stepId.xxx}}` / bracket 路径实际引用的步骤 id 同名；简单 `{{name}}` 参数不被误判为跨步依赖 |
| enumMap | 调用 label 与 wire value 本来就可能不同 | 显式、可解释转换；非法 label 在发送前抛 `EnumMappingError`，验收按声明映射后的 wire 值比较 |

## 4. 新矩阵判据与回溯结果

矩阵保存调用参数快照、服务端落库原文、逐字段差异和转换说明。报告成功但无记录或字段不一致会直接失败；无可比较原文标 `unverified`，不计成功。

真实结果：**16/19 可回放且逐字段验证通过；0 个静默错误；0 个未验证成功格位。** 三个未恢复格均在发送前明确中止。

| 格位 | 归因（新判据） |
|---|---|
| C1 | PASS；数组 cardinality 与值集合逐项一致 |
| C2 | PASS；文件路径按浏览器 multipart 转为 filename，逐 basename 验证 |
| C3 | PASS；多个文件逐 basename 验证 |
| C4 | PASS；HTML/text 两个表示字段均一致 |
| C5 | PASS；两组级联数组均完整一致 |
| C6 | PASS；最终选择值集合一致 |
| C7 | PASS；树节点集合一致 |
| C8 | PASS；标准 IDL value 重新归因为 user-input/network-body |
| C9 | PASS；滑块数字一致；保留为参数化数值端长期回归 |
| C10 | PASS；日期字符串一致 |
| C11 | PASS；两日期字段均一致，空串缺陷消失 |
| C12 | PASS；`false` 未被忽略，落库 false |
| C13 | PASS；标签集合一致 |
| C14 | PASS；响应映射后的 id/name 两字段一致；保留为跨表示映射端长期回归 |
| C15 | PASS；动态行对象数组逐字段一致 |
| C16 | 安全中止；runtime 已能读取 `textContent`，但录制期 `domMutations` 未包含合计展示节点，Analyzer 无 locator 可建立 page-derived carrier；TODO 未发送 |
| B1 | PASS；checkbox 多值按 value 匹配，非位置分配 |
| V6 | 安全中止；提交时生成且 DOM/响应/调用方均无可重现来源，按用户文档规定生成 TODO 并拒绝执行 |
| A 组 | 安全中止；仅观察到 `centerName=研发中心`，没有证明 `center=RD` 映射关系的 DOM/HTTP 证据，故生成 TODO；加载期守卫先中止，完整 A 组未触发 merged 载体防线 |

### 4.1 每个可回放格位的服务端落库原文

| 格位 | 原参数回放落库 | 跨参数回放落库 |
|---|---|---|
| C1 | `{"tags":["T1","T3"]}` | `{"tags":["T2","T4"]}` |
| C2 | `filename="invoice-receipt.png"` | `filename="replacement-1-invoice-receipt.png"` |
| C3 | `filename="expense-detail.pdf"`, `filename="receipt-2.png"` | `filename="replacement-1-expense-detail.pdf"`, `filename="replacement-2-receipt-2.png"` |
| C4 | `{"contentHtml":"第三季度预算说明：含差旅与采购","contentText":"第三季度预算说明：含差旅与采购"}` | `{"contentHtml":"<p>替代内容</p>","contentText":"替代内容"}` |
| C5 | `{"localRegion":["浙江省","杭州市","西湖区"],"remoteRegion":["江苏省","南京市","鼓楼区"]}` | `{"localRegion":["江苏省","苏州市","姑苏区"],"remoteRegion":["广东省","广州市","天河区"]}` |
| C6 | `{"selected":["u2","u3"]}` | `{"selected":["u1","u4"]}` |
| C7 | `{"nodes":["上海","浦东","徐汇"]}` | `{"nodes":["华北","北京"]}` |
| C8 | `{"qty":5}` | `{"qty":9}` |
| C9 | `{"level":7}` | `{"level":2}` |
| C10 | `{"leaveDate":"2026-09-15"}` | `{"leaveDate":"2026-09-22"}` |
| C11 | `{"startDate":"2026-09-05","endDate":"2026-09-18"}` | `{"startDate":"2026-09-03","endDate":"2026-09-12"}` |
| C12 | `{"notify":true}` | `{"notify":false}` |
| C13 | `{"tags":["需发票","月度报销"]}` | `{"tags":["常规","无需审批"]}` |
| C14 | `{"approverId":"u3","approverName":"王五"}` | `{"approverId":"u4","approverName":"王小明"}` |
| C15 | `{"items":[{"name":"会议室预定","qty":3},{"name":"待填写","qty":0}]}` | `{"items":[{"name":"保洁服务","qty":8},{"name":"待填写","qty":0}]}` |
| B1 | `{"benefit":["A","C"]}` | `{"benefit":["B"]}` |

完整记录位于本轮当前代码生成的 `tmp/matrix-*/summary.json`；未混用历史版本产物。

### 4.2 三个安全中止格位的精确边界

**C16**：不是 page-derived runtime 缺少 `textContent` 读取能力。`materializePageDerived` 已按 `value → checked → aria-valuenow → aria-checked → textContent` 读取，专项用例也验证了纯展示值可物化。该格真正缺少的是录制期定位证据：当前 `captureObservableElements()` 只观测标准表单、ARIA 状态和 contenteditable 值载体，合计 `<span>` 没进入 `domMutations`，因此 Analyzer 无法获得其 locator，也无法证明请求里的 `totalAmount=860` 来自哪个页面节点。Phase 2 不扩大全页采集，故保守生成 TODO 并在发送前中止。

**A 组 / V-C-8**：选择动作只留下 `centerName=研发中心` 的 IDL value，录制中没有 DOM 选项 value 或响应数据能证明 `研发中心 ↔ RD`。因此 `center` 保持 TODO。回放在 `assertNoUnresolvedExecutableValues` 加载期抛 `UnresolvedValueError`，请求数为 0；这发生在通道执行前，所以完整 A 组**没有触发** merged 载体防线。Phase 0 独立长期回归仍证明：当 network 请求确实消费 merged 值且安全降级被尝试时，会抛 `ChannelCarrierMissingError`，不会空值提交。两项证据不可互相替代。

**V6**：`requestId`、`clientId`、`clientTimestamp` 在提交时由运行环境生成，录制证据中没有调用方输入、可读 DOM、响应提取或可证明的生成规则。它们属于不可自动重现的 environment source；不得猜测、复制录制字面量或硬编码生成算法，只能生成 TODO、要求人工显式建模，并在未解决时拒绝执行。

## 5. C12 跨参数归因补充

C12 的 caller value 为 boolean，source 为用户对标准 `role=switch` 的动作，representation 为 boolean，cardinality 为 single，primary carrier 为 network-body。跨参数 `notify=false` 不经过真值兜底、不被初始页面状态覆盖，服务端原文为 `{"notify":false}`。

## 6. Safety Gate

### 6.1 十参数四问审计

| 参数 | source | representation | cardinality | carrier |
|---|---|---|---|---|
| C1.tags | user-input | json | multiple | network-body |
| C4.contentHtml | user-input | string | single | network-body |
| C5.localRegion | user-input | json | multiple | network-body |
| C5.remoteRegion | user-input | json | multiple | network-body |
| C8.qty | user-input | number | single | network-body |
| C9.level | user-input | number | single | network-body |
| C10.leaveDate | user-input | string | single | network-body |
| C11.startDate | user-input | string | single | network-body |
| C11.endDate | user-input | string | single | network-body |
| C12.notify | user-input | boolean | single | network-body |
| C14.approverId | user-input | string | single | network-body |
| B1.benefit | user-input | json | multiple | network-body |

- Silent Wrong Success：**0**。正式定义和验证方法已写入 `docs/DSH-Phase0-SafetyGate.md`。
- TODO_UNRESOLVED 提交：**0**。C16、V6、A 组均在发送前中止，服务端新增记录为 0。
- 成功证据覆盖：**16/16** 可回放格位均有逐字段对照；未验证成功格位 **0**。
- C8/C11 的旧“HTTP 成功但数据错误”现在由矩阵断言直接捕获，不能被 200/`ok=true` 掩盖。
- C9 与 C14 分别覆盖简单数值参数化和 label/wire 跨表示映射，已标记为 Phase 3 以后不得删除的长期回归样本。

## 7. 通用性与边界

- 新判断只使用 Canonical action、DOM IDL state、HTTP body、source lineage 与显式 carrier。
- `packages/*` 未加入 Mock/OA/认证产品、固定端点、业务字段、框架类名或固定数量判断。
- 未修改 matrix fixture 形态，未给 downgrade 增补兼容逻辑，未放宽 Safety Gate。
- `packages/locator/src/recorder-probe.ts` 保持无分支差异。

## 8. 当前验证

- build：PASS。
- unit：38 files，256 tests PASS。
- matrix：19/19 测试执行 PASS；按新判据，16/19 可回放且逐字段落库验证 PASS，另外 3 格在发送前安全中止。
- Phase 2 carriers：4/4 PASS，包含 derived override 请求数 0。
- C9/C14 长期回归专项：2/2 PASS，均包含原参数与跨参数的服务端逐字段落库比较。
- constraints：PASS（framework-specific、package boundary 与相关约束全部通过）。
- 任务范围 TypeScript ESLint：PASS。
- 全量 E2E：152 passed，3 skipped，0 failed（155 tests，20.9 分钟）。
- 三项 skip 均为既有条件性用例：A3 rebuild、A8 Vue 2 条件 fixture、A10 Stretch；没有核心验收项被跳过。
- `git diff --check`、仓库边界与提交证据见最终提交记录。
