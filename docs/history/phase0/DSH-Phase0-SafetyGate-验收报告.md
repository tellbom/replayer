# DSH Phase 0 Safety Gate 验收报告

日期：2026-08-28

执行依据：[DSH-Phase0-SafetyGate.md](../../DSH-Phase0-SafetyGate.md)

目标：所有已知“执行成功但提交数据错误”的路径必须在副作用前明确失败。

## 0-1 TODO 拒绝范围排查

- `parseSkill` 原有拒绝逻辑：有，原位置在 `packages/core/src/schema.ts`。原实现于 `SkillSchema.parse` 后递归扫描整个 Skill。
- 原覆盖情况：解析后保留下来的 body、header、URL、UI、extract、postcondition 可被扫描；未知字段会被 Zod 丢弃，`params[].default` 因而漏检；诊断字段 `_notes`、`_healHistory` 被错误纳入。
- 库 API 是否绕过 `parseSkill`：是。GLM 路径为 `generateDraft()` → `draft.skill` → `replay()`，直接 Skill 对象不经过 `parseSkill`。
- 排查结论：**(c) 既有实现方向部分正确，但位置范围和入口覆盖均不完整**。

修复后的逐项覆盖：

| 位置 | 结果 | 说明 |
|---|---|---|
| params | 已覆盖 | 原始对象阶段扫描 `default`、`values`、`enumMap` |
| body 叶子 | 已覆盖 | 任意深度对象/数组 |
| headers | 已覆盖 | 静态与最终物化后各一次 |
| URL/query | 已覆盖 | URL 字符串整体扫描 |
| ui.value | 已覆盖 | 包含递归 `preAction` |
| merged 值 | 已覆盖 | merged 的 `ui.value` 与引用它的请求模板 |
| multipart | 已覆盖 | fields/file 引用参与递归扫描；当前执行器无可验证 multipart 载体时明确 `not_sent`，禁止空请求与 UI 降级 |
| extract | 已覆盖 | network/preflight/UI extract |
| postcondition | 已覆盖 | request 与 `match.where` |
| 诊断字段 | 已豁免 | `_notes`、`_healHistory` 可保留诊断文字 |

## T-109/T-110 工作区处置

- T-109 复选探索：未继续实现，完整保存在 `stash@{0}`，名称为 `phase2-reference: T109 checkbox exploration before Phase0`。
- T-110：保留并并入 0-7，包括枚举 label/value 映射、数组映射和 postcondition 集合比较。
- dist：已执行全工作区重建。

## 0-2 双重守卫

- 共用扫描实现：`packages/core/src/safety.ts` 的 `assertNoUnresolvedValue` / `assertNoUnresolvedExecutableValues`，只有一套递归判断。
- 关卡一：`parseSkill` 在 `SkillSchema.parse` 前扫描原始 YAML 对象，因此未知字段也不会先被剥离。
- 关卡二：
  - `replay()` 在浏览器获取、dry-run、任何步骤之前扫描直接传入的 Skill。
  - network 在最终模板和运行时 header 物化后、`page.evaluate(fetch)` 前再次扫描。
  - UI 在模板物化后、locator 执行动作前再次扫描。
- 违反时：`UnresolvedValueError`，`outcome=not_sent`。

## 0-3 拦截覆盖与 multipart 安全

九类可执行位置均有单测。对于当前契约无法表达/重建的 multipart 请求，不新增上传能力，也不猜测文件来源：

- network 发现 `Content-Type: multipart/form-data` 时抛 `UnsupportedMultipartError`，请求不发出。
- 引擎禁止该请求降级为 UI，抛 `ChannelCarrierMissingError`，避免点击页面提交空表单。
- GLM C2/C3 重跑的两次 replay 均无服务端记录。

## 0-4 merged 降级禁止

- 实现位置：`packages/replayer/src/engine.ts` 的 `assertUiFallbackCarrier`，位于所有 UI fallback 的统一入口。
- 判据：仅依据请求模板根引用与 `channel=merged` 步骤 ID；支持带连字符的步骤 ID，不使用端点名或业务字段名。
- 错误：`ChannelCarrierMissingError`，`outcome=not_sent`。
- 验收：真实浏览器用例确认 network `not_sent` 后不会执行 UI 提交，且只发生 network 前的一次确认。

## 0-5 参数校验

统一入口为 `validateExecutionParams`，`replay()` 在浏览器启动前调用，network 通道也在 fetch 前调用：

| 情况 | 错误 | outcome |
|---|---|---|
| 未声明参数 | `UnknownParameterError` | `not_sent` |
| 缺少 required 参数 | `MissingParameterError` | `not_sent` |
| enum 无法映射 | `EnumMappingError` | `not_sent` |
| 已冻结类型与实参形态不符 | `InvalidParameterTypeError` | `not_sent` |

错误信息经 sanitizer 处理，包含参数名、失败值和可用枚举值，并明确提示重新录制或修正调用参数。

## 0-6 UI 载体完整性

- 实现位置：`packages/replayer/src/channel-ui.ts`。
- 范围：仅 `riskLevel=write/critical`，read 步骤不检查。
- 时机：执行提交动作的 `preAction` 链后、最终提交动作前。
- 检查：fill/date/select/check 的当前 DOM 值必须与期望一致；原生 select 同时认可 option value/text，ARIA 控件依据 `aria-controls` 下 `role=option[aria-selected=true]` 读取标准选中态。
- 失败：`UiCarrierIncompleteError`，`outcome=not_sent`，最终 click 不执行。
- 暴露的既有问题：fixture 的日期动作完成后 DOM 当前值为空。旧用例仍点击并报成功；当前安全门明确中止。此项属于暴露旧静默错误，不是恢复或新增控件支持。

## 0-7 postcondition 匹配器

- 数组/数组：无序多重集合比较，长度和重复次数均需一致。
- 标量/数组：候选集合包含期望标量即可。
- 数组/标量：期望数组只能有一个元素且相等。
- 标量/标量：允许首尾空白、数值字符串、布尔字符串；保持大小写敏感，`0` 不等于 `false`。
- `enumValue`：标量和数组均逐项执行 label → value 映射；缺失映射抛 `EnumMappingError`，postcondition 保持 `outcome_unknown`，不以 label 原样兜底。

## Gate 验证

### G-0.1 Silent Wrong Success

| 场景 | 当前结果 | replay 落库 |
|---|---|---|
| A 组 merged 空值链 | GLM 组合场景先被 `EnumMappingError`/`UnknownParameterError` 拦截；独立 merged fallback 用例抛 `ChannelCarrierMissingError` | 0 |
| C12 传未知 `notify:false` | `UnknownParameterError` | 0 |
| A4 传未收录枚举值 | `EnumMappingError` | 0 |
| A7 传未收录枚举值 | `EnumMappingError` | 0 |
| B1 多值传给当前 boolean 冻结契约 | `InvalidParameterTypeError`；未继续实现 T-109 | 0 |
| C2/C3 无载体 multipart | `UnsupportedMultipartError` 后禁止 UI fallback | 0 |

**已知场景 Silent Wrong Success = 0。**

### G-0.2 TODO_UNRESOLVED 提交

GLM 当前代码重跑结果：

| 场景 | replay1 | replay2 | 服务端 replay 记录 |
|---|---|---|---|
| C4 | `UnresolvedValueError` | `UnresolvedValueError` | `[]` |
| C6 | `UnresolvedValueError` | `UnresolvedValueError` | `[]` |
| C8 | `UnresolvedValueError` | `UnresolvedValueError` | `[]` |
| V6 | `UnresolvedValueError` | `UnresolvedValueError` | `[]` |
| C7 | `UnresolvedValueError` | `UnresolvedValueError` | `[]` |
| C16 | `UnresolvedValueError` | `UnresolvedValueError` | `[]` |

对全部 GLM replay 服务端记录执行匹配：`TODO_UNRESOLVED` 命中 **0** 处。

### G-0.3 回归

- 全工作区 build：通过。
- unit：33 files，225 passed，0 failed。
- Phase0/回退专项 E2E：5 passed。
- GLM 覆盖矩阵：19 passed；矩阵测试通过表示证据采集完成，业务判定以上述 server record 为准。
- 全量 E2E：124 passed，0 failed，3 skipped（A3 rebuild 环境门、A8 Vue2 条件门、A10 Stretch 均为既有非核心 skip）。
- scoped lint：本次修改文件 0 error。
- 全局 lint：基线仍有 86 个与本次改动无关的问题，来源为 `tmp/`、`vendor/playwright-injected/` 和既有 `apps/mock-portal/start-all.mjs`；未为本任务扩大范围修复。

全量 E2E 首轮暴露一项旧测试契约：`channel-network.spec.ts` 传入未声明的 `items` 参数。按 Phase0 规则补入参数声明后，该用例单独重跑通过；没有放宽未知参数守卫。

## 总结

- Phase0 安全门位于后续重构不会替换的 Skill 加载、runtime、channel 与 postcondition 层。
- `packages/*` 新判断只使用结构化参数、DOM/ARIA、HTTP header、模板引用和数据流，不含 Mock/OA/端点/业务字段/框架特判。
- T-109 仍停止并保存在 stash；本阶段没有新增复选契约或控件能力。
- 当前遗留问题均以明确失败呈现；Phase1/Phase2 再负责交互捕获、ValueLineage、Channel Planner 与控件能力。

结论：Phase0 三项 Gate 均满足，可进入 Phase 1。
