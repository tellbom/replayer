# DSH Browser Skill · Phase 3 Cutover 执行报告

日期：2026-08-31
状态：Phase 3 Gate 通过，已提交
分支：`codex/phase2-dataflow`
基线：`846c4dc`

## 1. 3-1 删除前对照（硬门）

### 1.1 证据生成约束

- attachment `DSH-Phase3-Cutover.md` 已原样保存到 `docs/history/phase3/`；源文件与项目副本 SHA-256 均为 `7B0E95B5F15E0154E681342BDEE0CE69EFDFC8F1387F5C1332073EE0E8775B55`。
- fixture 两条路径均调用真实 `record()`，不以 probe 的重复 emission 代替录制结果。
- legacy 与 canonical 各自独立录制，不做结构降级或 downgrade 对齐。
- 能力匹配至少需要相同动作种类，且必须再有 target token 或值的交集；只有动作种类相同不算覆盖。所有成功匹配的最低分为 8，门槛为 7。
- 本次没有修改任何 matrix fixture 形态，也没有修改 legacy recorder。
- 对照使用的构建产物哈希：legacy probe `2BA365E258386132372B098FA76595120084C87177CB198AA61180A1A80C6040`；canonical probe `D641B7683EF577F15A8E2B3FCECD9637F9B845ECAF99099A629058D500AE9A7C`。

### 1.2 fixture 对照（19 格）

命令：`npx playwright test e2e/phase3-predelete-comparison.spec.ts --workers=1`
结果：`1 passed (3.7m)`。

| 格位 | legacy 动作数 | canonical 动作数 | legacy 独有 | 归因 |
|---|---:|---:|---:|---|
| C2 | 2 | 2 | 0 | 无 |
| C3 | 2 | 2 | 0 | 无 |
| C16 | 9 | 10 | 0 | 无 |
| C1 | 2 | 2 | 0 | 无 |
| C5 | 13 | 13 | 0 | 无 |
| C13 | 3 | 3 | 0 | 无 |
| C4 | 1 | 2 | 0 | 无 |
| C6 | 2 | 4 | 0 | 无 |
| C7 | 3 | 3 | 0 | 无 |
| C8 | 5 | 2 | 0 | 无；动作次数不用于替代能力证据 |
| C9 | 2 | 2 | 0 | 无 |
| C10 | 2 | 3 | 0 | 无 |
| C11 | 3 | 4 | 0 | 无 |
| C12 | 2 | 2 | 0 | 无 |
| C14 | 4 | 5 | 0 | 无 |
| C15 | 2 | 5 | 0 | 无 |
| B1 | 3 | 3 | 0 | 无 |
| V6 | 2 | 4 | 0 | 无 |
| A 组 | 9 | 11 | 0 | 无 |
| **合计** | **71** | **82** | **0** | fixture 部分通过 |

机器可读原始证据由当前代码生成于 `tmp/phase3-predelete/fixture-comparison.json`；`tmp/` 不纳入提交，关键汇总和构建产物哈希永久归档在本报告。

### 1.3 真实系统对照

环境：`replayer-web-test`，Vue 3 + Element Plus 2.8.8，Keycloak 模式。
认证：在独立持久化 Chrome 档案中交互完成；采集程序检测认证完成后才开始，登录动作不录制。
业务写入：不点击最终提交，只操作 native select、日期面板、radio、自定义 div 下拉和 textarea。

| 交互能力 | legacy | canonical | legacy 独有 | 说明 |
|---|---:|---:|---:|---|
| 原生 select 选择 | 1 | ≥1 | 0 | target 与 value 双证据匹配 |
| 日期输入激活 | 1 | ≥1 | 0 | target 证据匹配 |
| 日期面板日单元点击 | 0 | 1 | 0 | canonical 独有 |
| radio 选择 | 1 | ≥1 | 0 | `value=afternoon`、`checked=true` 双证据匹配；canonical 另保留 label activation |
| 自定义 div 下拉输入 | 1 | ≥1 | 0 | target 与 value 双证据匹配 |
| 自定义 div option 点击 | 0 | 2 个原始事件动作 | 0 | canonical 独有，保留 pointer/click 证据 |
| textarea 编辑 | 1 | ≥1 | 0 | target 与 value 双证据匹配 |
| **原始动作合计** | **5** | **10** | **0** | canonical 独有 4 |

首次对照曾显示 1 个 legacy-only；归因后确认是测试对照器把 legacy 的 `type: radio` 错误归一化成 `upload`。对应 canonical `kind: check` 已完整记录相同 target、`value=afternoon` 和 `checked=true`，不是产品漏捕。修正测试归一化为 `radio/checkbox → check` 后，直接针对同一对原始 `record.json` 重新计算，结果为 legacy-only 0。产品代码、fixture 与两份原始录制均未修改。

机器可读原始证据：`tmp/phase3-predelete/real-system/{legacy,canonical}/record.json` 与 `comparison.json`；关键结果已在本报告归档。

### 1.4 G-3.1 结论

- 19 格 fixture：legacy 独有能力 0。
- 真实 Vue 3 + Element Plus 2.8.8 系统：legacy 独有能力 0。
- canonical 额外证明日期面板日单元、radio label activation、自定义 div option pointer/click 等 legacy 没有的交互证据。
- **G-3.1 PASS，可以进入 legacy 删除。**

## 2. 3-2 / 3-3 Canonical 单路径 Cutover

### 2.1 删除结果

- 删除 `RecordSession.actions`、`recorderPath`、CLI `--recorder-path` 与所有分支选择。
- 删除 `packages/locator/src/recorder-probe.ts` 及其构建产物入口；Recorder 只注入 canonical probe。
- Analyzer 删除 `fromLegacy`、`legacyKind`、`AnalyzedAction.legacy` 和 legacy scope/hint 投影，直接消费 `canonicalActions`。
- 删除只验证 legacy 选择、兼容转换或 legacy probe 的 E2E；T-68、T-69、T-72、T-77、LOW 消歧、scope 严格回放与 `waitAfter` 等仍有产品价值的断言已迁移到 Canonical IR，并在全量回归中执行。
- 删除旧 `params[].carrier.via=page-derived` 到 `internalValues` 的回放兼容桥；Schema 现在明确拒绝旧形态，当前 Analyzer 只生成独立 `internalValues`。
- 这是有意的录制契约断裂。历史 `record.json`、skill、`tmp/` 与 fixture 不迁移、不兼容，必须由当前版本重新录制。

生产范围扫描未发现 `recorderPath`、`--recorder-path`、`fromLegacy`、`legacyKind` 或 legacy probe 引用。`canonical-recorder-probe` 是当前唯一 probe，不属于 legacy 命中。

### 2.2 T-105 迁移结论

T-105 旧用例曾同时断言两个 UI fill 与 network write；Canonical 显式载体模型规定 `network-body` 为主载体时不混入冗余 UI 执行步骤。因此验收迁移为：

1. caller 参数 `shared` / `shared_2` 的 source action 分别为 0 / 1；
2. 两者 primary carrier 均显式为 `network-body`；
3. 请求体分别生成 `first={{shared}}`、`second={{shared_2}}`；
4. 服务端实际落库 `runtime-first` / `runtime-second`；
5. 故意构造旧错误合并形态时，服务端仍会接受两个相同错误值，P0 定级证据保留。

这不是删除 T-105 能力，而是去掉 legacy 的隐式双通道表现，保留 C28 的 source lineage 核心不变量。

## 3. 3-4 框架命名兼容清理

- `el-form-item`、`el-option`、`el-dialog-scoped`、`el-table-cell` 已从类型、Schema 和 runtime 删除，新旧 draft 均不再接受。
- Analyzer 中通过字符串拼接隐藏的旧 strategy 校验与 label 降级兼容也已删除；不存在绕过 CI 的运行时识别。
- `scripts/check-no-framework-specifics.mjs` 不再含 `@deprecated` 豁免；生产 `packages/**/*.ts` 扫描结果为 0 命中。
- `adapters/` 保留 `.gitkeep` 与 README，目录中没有实现代码。README 固化：core 不 import adapter、adapter 只增加证据、失效时 core 通用路径不崩、不得绕过 Safety Gate。
- `selectOption`、`setDateTime`、`inDialog`、`tableRowButton` 均保留在通用 DOM/ARIA/IDL 实现中。历史测试文件名可保留，但不参与生产扫描。

## 4. Phase 2 遗留关闭

### 4.1 merged 防线完整链路

`e2e/fallback.spec.ts` 构造了合法参数、无 TODO、存在 merged 依赖的完整 skill：先让 network step 得到 `not_sent`，再进入最后一道载体检查。

结果：

- 抛出 `ChannelCarrierMissingError`；
- 请求发送数 0；
- 服务端落库 0；
- UI 提交数 0；
- 只发生 network 前的一次写确认，未发生 UI 降级确认。

该防线在当前架构下可达，且没有通过弱化参数校验、TODO 守卫或 fixture 形态构造。

### 4.2 展示节点观测评估（只测量，未实现）

命令：先用 esbuild 把 `scripts/phase3/evaluate-display-observation.ts` 编译到 `tmp/`，再由 Node 执行。真实系统使用既有已认证持久化 profile，只导航与填写，不点击提交。

| 指标 | C16 fixture | 真实系统只读流程 |
|---|---:|---:|
| 初始 value carrier | 0 | 1 |
| 最终 value carrier | 6 | 12 |
| 初始展示候选 | 12 | 1066 |
| 最终展示候选 | 18 | 437 |
| observer callback | 9 | 7 |
| callback 总耗时 | 2.3 ms | 6.4 ms |
| callback 最大耗时 | 0.9 ms | 3.3 ms |
| 发生变化的展示元素 | 3 | 22 |
| 变化文本序列化体积 | 43 bytes | 4047 bytes |
| sanitize 后体积 | 43 bytes | 4047 bytes |
| 被后续请求消费的展示值 | 1 | 0 |

结论：C16 证明展示值存在收益，但真实页面用宽泛展示节点观察会快速扩大候选、噪音和 PII 面，而本次只读交互未发现被请求消费的展示值。回调耗时在该小样本中不高，但不足以证明长时录制安全。**Phase 3 不实现扩大全页观测**；建议后续单独立项，只评估“动作因果窗口 + 后续请求叶子消费 + sanitize/上限”的窄采集方案。

## 5. Matrix 与逐字段落库

最终显式命令：`npx playwright test e2e/matrix/matrix.spec.ts --workers=1`，结果 `19 passed (5.2m)`。其中 16 格逐字段验证成功，3 格发送前安全中止。

| 格位 | 原参数落库原文 | 跨参数落库原文 |
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

三个安全中止格位：

- **C16**：runtime 支持读 `textContent`，但录制期没有合计展示节点 locator，因此无法建立 page-derived lineage；TODO 在发送前被拒绝。
- **V6**：值只在提交时生成，DOM、响应和调用方都无可复现来源；TODO 在发送前被拒绝。该不支持边界已写入用户文档。
- **A 组**：只有展示值与 wire 值，缺少两者映射证据；不得猜测，故安全中止。独立的 merged 完整链路由 §4.1 验证。

C12 跨参数补充：caller value 是标准 `role=switch` 的 boolean user-input，cardinality 为 single，primary carrier 为 network-body。`false` 不经过真值兜底，服务端原文明确为 `{"notify":false}`。

## 6. Safety Gate

| 守卫 | 最终值 |
|---|---:|
| Silent Wrong Success | 0 |
| TODO literal submissions | 0 |
| 逐字段落库验证成功 | 16/16 |
| 未验证成功 | 0 |

定义按 Phase 0 长期文档执行：报告成功但无调用参数与服务端落库逐字段原文的格位，不计成功。

## 7. Cutover 中发现并修复的回归

首次删除后，matrix 从 16/19 降至 10/19，按 Safety Gate 红线停止提交并完成归因：

1. initial-state observer 在 `documentElement` 尚不存在时启动，异常使 canonical flush/navigation 安装链中断；改为 DOM ready 后再观察。
2. Analyzer 错把“同一个 source 产生多个 wire 字段”合并，并用 DOM name 代替 aggregate/body wire field；改为 source lineage 与 wire field 双重归属，保留一源多表示。
3. response alias 曾把仅搜索返回的 ID 当 caller param；现在只有明确 choice/option/domain 证据才生成 caller 参数，否则走跨请求依赖。
4. draft 的 action→param binding 改为 direct interaction first-wins，避免 response-derived body field 覆盖直接 query 参数。
5. T99 全量偶发失败是测试中 `/neutral` 导航加载了真实登录页，状态合法变成 unauthenticated；测试现在固定返回中性 HTML，认证产品逻辑未改，连续三轮 12 项通过。
6. 同一动作值命中多个 URL query leaf 时，旧逻辑为避免误绑而保留录制字面量；现在将歧义 leaf 标为 `TODO_UNRESOLVED`，加载期响亮失败，避免调用方参数被静默忽略。
7. partial 恢复若恰有 `4n+4` 个动作，探针初始导航可能在网络录制器初始化前触发检查点；现改为先建立网络录制器再注入 probe。
8. canonical probe 的增量 emission 曾让同一 LOW 动作重复调用消歧；现按 canonical actionIdx 缓存目标精炼结果，完整原始事件序列不变，消歧每动作只执行一次。

修复没有给 downgrade 打补丁、没有修改 matrix fixture 形态、没有放松任何 Safety Gate。

## 8. 文档收敛

- 新增 `docs/DSH-Architecture-Overview.md`，独立说明录制→IR→Analyzer→Lineage→Planner→Replay，并逐条盘点 C1–C28。
- README 只保留 Canonical 默认录制流程。
- `docs/skill-authoring.md` 写明 derived 边界：标准 IDL `value/checked` 是用户输入证据；被后续请求消费且有 locator 的非表单 `textContent` 才可成为页面派生证据。
- C16 展示节点与 V6 环境生成值的不支持边界已进入用户文档。
- Phase 0–3 历史任务与执行报告移动到 `docs/history/phase0..3`，不删除设计依据。

## 9. 最终验证

| 检查 | 结果 |
|---|---|
| `npm run build` | PASS；仅 Vite vendor PURE 注释与 chunk size 警告 |
| `npm test -- --run` | PASS：37 files，262 tests |
| `npm run check:constraints` | PASS；credentials、framework token、package boundary 全部通过 |
| changed TypeScript/ESM ESLint | PASS：变更文件 0 error |
| Matrix 19 格 | PASS：19/19；16 成功 + 3 安全中止 |
| C9 / C14 长期样本 | PASS：显式过滤 2/2；全量 matrix 也通过 |
| 全量 E2E | PASS：148 passed，3 skipped，0 failed（14.9m） |

首次全量执行在 merged 长期守卫完成 `ChannelCarrierMissingError` 与确认次数断言后，查询落库数时遇到一次 Chrome 同 profile 重开关闭竞态，按红线立即中止。该守卫随后独立连续 3 轮通过，第二次完整 151 项套件也通过；守卫判据和产品实现均未放宽。

skip 必须逐项列出：A3 rebuild/CSS hash、A8 Vue2 条件未启用、A10 Stretch 未启用。A3 属于核心验收覆盖缺口，高亮为 **skip，不计成功**；A8/A10 是环境/范围条件未启用。

## 10. 交付边界

- 分支：`codex/phase2-dataflow`；基线 `846c4dc`。
- 实现提交：`7913b0c`（`refactor: complete canonical recorder cutover`）；完整交付范围为 `846c4dc..HEAD`，本报告最终化提交位于实现提交之后。
- 主工作区 `E:\replayer` 的既有脏文件未修改、未暂存；所有 Phase 3 改动位于隔离 worktree。
- 本报告不记录认证口令、Cookie、Authorization 或 bearer token。
- 未 merge、未 push；按交付裁决保留隔离分支供 GLM 复核。
