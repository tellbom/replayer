# DSH Browser Skill · Phase 1 Foundation 执行报告

日期：2026-08-29

执行基线：当前工作区（仅提交 Phase 0 修正与 Phase 1 范围文件）

裁决基线：`DSH-Phase1-Foundation.md` 及后续九条设计确认、第 7 条替换裁决

## 结论

Phase 1 已完成，Gate 通过，可交付 GLM 做不变量验证。默认录制路径已切到 Canonical Recorder；`canonicalActions` 是唯一真相源，`actions` 仅由 `downgrade(canonicalActions)` 单向派生供 shadow compare。生产路径未引入业务端点、业务字段、前端框架或 fixture 判断。

T-105 补报结论：**P0（静默错误）**。回归用例先验证修复后的两个 source lineage 分别填入、提交并落库，再故意构造旧版错误合并形态，使两个请求叶子都引用同一参数。请求仍返回成功，服务端接受并记录两个相同错误值，证明历史缺陷存在“绑错且真正提交”的路径。当前修复已由同一用例封堵；按裁决不迁移历史测试数据。

## 1-0 前置排查与 Phase 0 修正

### A · 日期 DOM 值归因

- 归因结论：此前以 content attribute 观察用户输入会产生假阳性；Phase 0 UI 载体校验当前读取 IDL property，不读取输入框的 `value` attribute。
- 证据：`phase1-strict-actionability.spec.ts` 对 readonly 标准输入执行写入后，IDL `value` 为 `2026-08-28 18:00:00`，HTML `value` attribute 仍不是该值；用例通过。
- 载体守卫证据：`phase0-safety.spec.ts` 中页面在 `input` 事件后清空 IDL value，守卫返回 `not_sent`，提交点击计数保持 0。
- 处置：通用 readonly 输入使用浏览器 IDL setter 并派发标准 `input/change`；载体验证继续基于 live IDL `value/checked`。未读取组件内部 model，未引入框架 API。

### B · multipart 判据

- 当前触发条件：`classifyMultipartCarrier()` 仅把 multipart 中的文件/二进制或无法重建的载体判为 `unsupported`；普通对象、`URLSearchParams` 与文本表单可重建。
- 纯文本 multipart：正常发送。执行器在浏览器上下文重建 `FormData`，删除录制时 boundary，让浏览器生成当前 boundary。
- 文件型 multipart：在请求发出前返回 `UnsupportedMultipartError/not_sent`。
- 是否需要收窄：是，已从“multipart 一律拒绝”收窄为“只有不可验证文件/二进制载体拒绝”。对应单元用例三条均通过。

### C · 畸形输入健壮性

- 已补测循环引用、YAML alias 重复引用、深度超过具名上限 256、`Set` 等非常规容器。
- 扫描改为有界迭代遍历；全部转换为明确的 `ExecutableValueTraversalError` / schema 错误，不发生栈溢出或未捕获异常。

### D · merged 长期回归标记

- 已在 `fallback.spec.ts` 标记 `[long-term]`。
- merged 依赖缺失时保持 `ChannelCarrierMissingError`，不得降级为可能写错数据的 UI 提交。

## 1-1 Canonical Action IR

- `ir.ts`：`packages/core/src/ir.ts`。
- `kind` 包含 `unknown`：是；分类失败只影响标签，不影响记录。
- `actionIdx`：与 T-96 `RecordedRequest.actionIdx` 使用同一序号空间；request 通过 `effects.requestIds` 引用，不复制请求内容。
- `raw.eventTypes`：保留合并前完整原始事件序列；unknown、key、upload 的降级损失写入 `_notes`。
- `affected` 上限：`CANONICAL_CAPTURE.maxAffected = 20`。
- `innerHTML` 上限：`CANONICAL_CAPTURE.maxInnerHtmlLength = 8192`。
- ARIA 状态：`checked / selected / expanded / valuenow / valuetext / pressed / disabled / invalid`。
- `enumOptions`：在交互时刻从标准 `select.options` 或可访问的 `role=option` 采集，经 sanitize，最多 200 项并携带完整性标记；它仅是当组选项证据，不等同于静态枚举证据。
- V-108-8：上游变化后选项集合变化的用例判为 `contextual`，不静态固化。

## 1-2 Canonical Recorder

- 监听：`pointerdown / pointerup / click / beforeinput / input / change / keydown / compositionstart / compositionend / focus / blur / drop`，并记录页面导航。
- target 过滤：无。监听入口不按 tag、class、role 或控件类型决定是否记录。
- 合并：复用 T-96 active action 的目标身份与时间边界；同目标事件合并，未分类动作输出 `unknown`。
- 状态观察：记录 target before/after、URL、焦点、受影响的值载体、DOM mutation、request IDs 与 navigation。
- unknown 证据：target、before、after、effects、`raw.eventTypes`、trusted、unclassifiedReason 均保留。
- 容灾：动作开始时先发 provisional 记录，settle 后按相同 actionIdx upsert；页面导航销毁上下文或异常结束时不丢动作。
- `ir-downgrade.ts`：已建，文件头明确“Phase 2 ValueLineage 完成后删除”；仅结构转换，不做来源或类型推断。
- 单向派生：Canonical 模式下 session 的 `actions` 在录制期间和结束时均由 `canonicalActions` 降级生成；不存在旧捕获失败后回退 legacy recorder 的路径。

## 1-3 Actionability 清理

- `count()` 唯一性预检：已从执行路径删除。
- 手写 visible/enabled/stable/bounding-box actionability：普通 Playwright 动作路径已删除，交给 Playwright；readonly IDL fallback 仍保留必要的 enabled/stable 安全校验，因为它绕过普通 `fill()`。
- strict mode 实测：两个同名 `Continue` 按钮产生 `strict mode violation`，两个按钮的点击标记均未出现；不是静默取第一个。
- T-84 语义漂移断言：保留并全量通过。
- Phase 0 UI 载体完整性：保留并全量通过。
- `settleNavigation`：保留。

## 1-4 Framework-specific 全库盘点与处置

盘点命令针对修改前 `HEAD:packages/**/*.ts`，排除 test/spec/vendor。以下为完整的生产文件级命中与四选一判定；同一文件内重复选择器归并列出，但没有省略任何命中文件。

| 原位置 | 原能力/命中 | 判定 | 处置与理由 |
|---|---|---|---|
| `packages/analyzer/src/params.ts` | 旧 option strategy 参数映射 | fixture 特判 → 删除 | 参数关联继续按 DOM 动作、请求叶子值和 source lineage；不识别私有策略 |
| `packages/browser/src/context.ts` | 加载旧框架 locator bundle | 通用重写 | 改加载 `dom-locator.iife.js` |
| `packages/cli/src/doctor.ts` | 框架类型、私有 class 探测、版本结论 | fixture 特判 → 删除 | doctor 只报告 DOM/ARIA 可观察能力，不按技术栈分类 |
| `packages/core/src/types.ts` | 四种旧 strategy 与版本 API | 旧契约兼容 | 四种 strategy 暂留并逐项标 `@deprecated + TODO(Phase 3)`；版本 API 删除 |
| `packages/core/src/schema.ts` | 四种旧 strategy schema | 旧契约兼容 | 只供旧 skill 解析，逐项标 `@deprecated + TODO(Phase 3)`；新 draft 校验禁止生成 |
| `packages/llm/src/heal.ts` | prompt、fallback、resolver 中的私有 strategy/class | 通用重写 | prompt 与候选改为 label/role/css/Playwright；浏览器验证只用标准 DOM/ARIA |
| `packages/locator/src/ancestor-scope.ts` | 私有 card/collapse/tab 容器 | 通用重写 | 使用具名 role、fieldset、section、heading 等标准语义 |
| `packages/locator/src/el-locator.ts` | 全部执行辅助与版本识别 | 通用重写/删除 | 能力迁入 `dom-locator.ts`；版本识别删除；原文件删除 |
| `packages/locator/src/mutation-tracker.ts` | 私有 option、dialog、listbox、date、menu、row、panel、portal class | 通用重写 | 使用 role、ARIA、dialog、menu、row、region、fieldset、popover/visibility 与 DOM 出现时序 |
| `packages/locator/src/pw-selector-generator.ts` | 私有 runtime-id 示例注释 | 通用重写 | 改为一般运行时动态 id 描述 |
| `packages/locator/src/recorder-probe.ts` | 私有 label/option/select/date class | 通用重写 | legacy 路径也改用 label、`aria-controls`、role option/combobox 与标准 input |
| `packages/locator/src/snapshot.ts` | 私有 dialog/form/table/select/date class | 通用重写 | 只快照标准可访问控件、dialog、table 与 live IDL state |
| `packages/replayer/src/channel-ui.ts` | 自动构造旧 strategy | 通用重写 | label fallback、Playwright locator、标准 select/combobox/option 与 IDL setter |

### `el-locator.ts` 方法逐项判定

| 方法/能力 | 判定 | 通用实现 |
|---|---|---|
| `byFormItem/control` | 可通用化 | label 关联、ARIA accessible name、标准 form control |
| `selectOption` | 可通用化 | native `selectOption`；自定义控件按 `role=combobox` 激活并精确点击 `role=option` |
| `setDateTime` | 可通用化 | 标准 input/textarea IDL setter + `input/change`，并验证 live value |
| `inDialog` | 可通用化 | `role=dialog`/原生 dialog，等待可见与过渡稳定后限定作用域 |
| `tableRowButton` | 可通用化 | `role=row`/标准 `tr` 的可访问文本锚点，再定位行内按钮 |
| `resolve` | 可通用化 | label/text/role/css/Playwright 标准策略 |
| `robustClick` | 可通用化 | Playwright actionability + DOM/ARIA 目标，不使用 force 或私有遮罩 class |
| `setInputValue` | 可通用化 | 标准 IDL property setter 与浏览器事件 |
| `waitFor` | 可通用化 | 标准可见性和状态等待 |
| `version` | 无通用产品价值 → 删除 | 不再探测或返回框架版本 |

- `EL_STRATEGIES`：选择器优先级规则已随旧文件删除；Canonical Recorder 不引用。
- 新 draft 防线：出现任一旧 `el-*` strategy 立即报错，单元用例通过。
- `adapters/`：已建立，最终为空（仅 `.gitkeep`）；没有能力必须依赖私有 class，因此没有迁入 adapter。
- `packages/locator/src/compat.ts`：确认不存在，无现存文件可迁移，未伪造兼容层。

## 1-5 CI 防回流与包边界

- `scripts/check-no-framework-specifics.mjs`：扫描 `packages/**/*.ts`，排除 test/spec/vendor/dist；六组禁止模式全部实现。
- 唯一豁免：同一类型/schema 定义附近同时含 `@deprecated` 与 `TODO(Phase 3)`；`adapters/` 不进入 packages 扫描。
- 负向实测：临时加入 `packages/core/src/violation.ts`，内容含 `.ant-button`，检查输出具体文件/行并以 `scanner_exit=1` 失败；随后删除临时文件。
- `scripts/check-package-boundaries.mjs`：实现 analyzer→recorder、core→adapter、core/analyzer/replayer/browser→adapter、locator 浏览器 bundle 外部 npm import 四项边界。
- `npm run check:constraints` 已串联原安全约束、framework 防回流和 package boundary，全部通过。

## Gate · Shadow Compare

| 判据 | 结果 | 证据 |
|---|---|---|
| 新动作集合 ⊇ 旧动作集合 | PASS | 旧可执行签名 3；Canonical 共 8；降级后可执行签名 4；旧有新无 0 |
| semantic target 等价 | PASS | 共同动作由相同 Playwright 语义 selector 对齐；Canonical 另保留 role/accessibility/name/neighborhood 证据 |
| 回放不劣化 | PASS | 全量 E2E 127 passed，旧通过新失败 0 |
| Safety Gate 无退化 | PASS | UI carrier、multipart、merged fallback、语义漂移、身份切换、未知写结果均通过；Silent Wrong Success = 0 |

- 新路径额外可降级执行：1 个（contenteditable edit）。
- 新路径额外证据动作：2 个 unknown；其中 drop 等原始事件序列完整保留。
- TODO 变化：shadow fixture 旧 0 → 新 2 条 downgrade loss notes；它们是显式证据损失说明，不进入可执行写请求。

## 回归结果

| 检查 | 结果 |
|---|---|
| `npm run build` | PASS，全部 workspace 构建成功 |
| `npm test` | PASS，36 files / 235 tests |
| `npm run check:constraints` | PASS |
| 本任务变更文件 ESLint | PASS，0 error |
| 仓库级 `npm run lint` | 基线 FAIL，86 errors；集中在 `vendor/playwright-injected` 等任务外存量目录，本任务文件无新增 |
| `npx playwright test --workers=1` | PASS，127 passed / 3 skipped / 0 failed，11.2m |
| shadow compare 最终定向复跑 | PASS，1 passed；量化数据见 Gate |
| T-105 P0 定级复现 | PASS，错误合并写路径被服务端接受；修复路径保持两个 lineage 独立 |
| T68-T74 + T84、T91-T108、Phase 0 验收 | 全部纳入全量 E2E/Unit 并通过 |

Skipped 逐项说明：

1. A3 rebuild：仅在显式 rebuild 条件开启时执行，属于条件型跳过。
2. A8 旧前端 fixture 条件：doctor 未启用该 fixture 条件，属于条件型跳过；生产代码已不按框架分类。
3. A10 Stretch：开放式探索未启用，按契约跳过。

Phase 1 核心验收项无 skip。

## 遗留与阶段边界

- 四种旧 framework-named locator strategy 只为解析历史 skill 暂留；Phase 3 删除。新数据不得生成。
- `ir-downgrade.ts` 与派生 `actions` 只服务 Phase 1 shadow compare；Phase 2 ValueLineage 完成后删除。
- T-109 参数类型探索仍按 Phase 0 裁决停止，等待 Phase 2 ValueLineage；T-110 存活层能力已并入 Phase 0 postcondition 集合匹配，不在本阶段扩契约。
- 历史 fixture、`tmp/`、`skills/`、`runs/`、`entries/` 产物未迁移；后续验收必须由当前代码重新录制。

**最终状态：Phase 1 Definition of Done 达成，可以进入 GLM Gate 验证；是否进入 Phase 2 由后续裁决决定。**
