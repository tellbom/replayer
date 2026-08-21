# T-90 外部方案对照评审报告

> 审计日期：2026-08-21
>
> 审计性质：只读外部对照；未修改产品代码
>
> workflow-use 基线：`main@891267bb614c0b0821adbb0f7fffc0ebbf045a38`

## 0. 执行摘要

DSH 的“一变体一 skill”不是错误方向，但也不是传统 RPA 唯一的主流做法：成熟 RPA 通常由开发者在设计器中显式加入 `If/Switch/Choice`，而 workflow-use 当前 schema 根本没有确定性分支或循环，因此它面对录制时不存在的字段也不能自动生成可靠分支。对 DSH 而言，保持多录制是现阶段安全且可审计的权宜之计；相近变体增多后，应先抽取共享步骤或提供人工合并工具，而不是让单条录制自动猜测未见分支。

workflow-use 的变量识别值得借鉴其“规则/上下文置信度 + 可选 LLM 建议”的分层思想，但其当前类型系统没有 enum、没有“声明未引用”检查，缺失 placeholder 甚至原样保留；T-86 的 `enumMap + 未引用参数报错 + 禁止响应数组固定下标` 明显更严格，也更适合企业写单场景。

DSH 的四态 `ExecutionOutcome`、写后确认、身份/会话边界和语义漂移门禁不是过度设计，而是针对不可逆企业写操作的实质优势。workflow-use README 宣称失败时回退到 agent，但当前代码的 fallback 已被注释，路线图也承认 fallback “currently really bad”；若未来恢复自动接管而仍不区分 `not_sent` 与 `outcome_unknown`，会有重复提交风险。

研究方向中，AutoRPA 与 AWM 都表明“多轨迹不是泛化的对立面，而是泛化的训练输入”。最值得记录的是企业 BPM 论文的分阶段上线、按动作风险分层、critic 主动弃权、按业务切片回滚；这些需要长期生产反馈数据，不应在本轮实现。

## 1. workflow-use 对照

### 1.1 项目状态核实

- 仓库：[browser-use/workflow-use](https://github.com/browser-use/workflow-use)。本次浅克隆的 `main` HEAD 是 [`891267b`](https://github.com/browser-use/workflow-use/commit/891267bb614c0b0821adbb0f7fffc0ebbf045a38)，提交时间为 2026-07-29；GitHub API 显示仓库最近有分支 push（2026-08-14），不能把它等同于 `main` 已合并更新。
- 2026-08-21 查询 GitHub API：4,143 stars、339 forks、61 个 open issues/PR（GitHub `open_issues_count` 同时计入 PR），未归档，仍有活动。
- 活跃不等于可生产使用。README 原文明确称项目处于 “very early development”，并称不建议用于生产。[README L15-L17](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/README.md#L15-L17)
- 当前公开问题进一步印证成熟度风险：[#165](https://github.com/browser-use/workflow-use/issues/165) 报告录制捕获零事件与 schema 422；待合并的 [#168](https://github.com/browser-use/workflow-use/pull/168) 自述确定性 replay 在 browser-use 0.13 上完全不可用；[#169](https://github.com/browser-use/workflow-use/pull/169) 仍在修复凭证/PII 从采集到回放的泄漏路径。
- README 的功能描述与代码现状存在偏差：README 称失败会 fallback 到 Browser Use，[路线图](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/README.md#L244-L256) 同时标注 LLM fallback 质量很差、自愈尚未完成。当前执行代码记录“Attempting fallback”后直接抛错，真正的 fallback 调用被注释；`run_with_no_ai()` 对 agent step 直接报错。[service.py L630-L718](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/service.py#L630-L718)、[service.py L1047-L1113](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/service.py#L1047-L1113)

评审判断：项目在持续开发且思路接近 DSH，但当前版本不构成生产成熟度标杆；对照必须以固定 commit 的代码为准，不能把 README 愿景当成已实现能力。

### 1.2 Schema 逐字段对照

DSH 对照基于 [`packages/core/src/schema.ts`](../../packages/core/src/schema.ts) 与 [`packages/core/src/types.ts`](../../packages/core/src/types.ts)。workflow-use 对照基于其 [schema/views.py](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/schema/views.py)。

| workflow-use | DSH | 差异 | 判断 |
|---|---|---|---|
| `name` | `skill.name` | 同为名称 | 无关 |
| `description` | `skill.description` | 同为描述 | 无关 |
| `version: string` | `skill.version: number` | 表达形态不同 | 无关 |
| 无明确 system/base URL | `skill.system`, `skill.baseUrl` | DSH 明确业务系统与 URL 边界 | DSH 更优 |
| 无 entry 引用 | `skill.entry` | DSH 将认证载体与 skill 分离 | DSH 更优 |
| `workflow_analysis` | 无等价运行字段 | workflow-use 会把生成推理随文件保存 | 不应借鉴；可能暴露敏感上下文且非执行契约 |
| `default_wait_time` | 无全局固定 sleep；步骤有 `waitAfter` | workflow-use 以时间等待为主；DSH 可表达 scope、URL、request、非空与 settle | DSH 更优 |
| `input_schema[].name` | `params[].name` | 等价 | 无关 |
| `input_schema[].type = string/number/bool` | `params[].type = string/number/date/datetime/enum/boolean` | DSH 类型更丰富 | DSH 更优 |
| `input_schema[].format/required/default` | `params[].format/required/prompt` | workflow-use 有 default；DSH 有 prompt，当前无通用 default | 可借鉴可审计的非敏感默认值，但非 T-86 必需 |
| 无 enum 声明/映射 | `params[].values/enumMap` | workflow-use 选择项仍是字符串；DSH 显式 label→value | DSH/T-86 更优 |
| `steps[]` 有序列表 | `steps[]` 有序列表 | 基本一致 | 无关 |
| step 无稳定 id | `step.id` | workflow-use 主要依赖数组位置；DSH 可稳定引用跨步输出 | DSH 更优 |
| `step.type` | `step.ui.action` 或 `step.network.method` | workflow-use 是 UI 动作/agent/extract；DSH channel 下再分执行形态 | 场景不同；DSH 更适合混合通道 |
| 无 channel | `step.channel = network/ui/merged/auto` | workflow-use 全部通过浏览器交互/语义层，无网络业务步骤模型 | DSH 独有优势 |
| `description` | `desc` | 等价 | 无关 |
| `output` | `network.extract`, `ui.extract`, `requires` | 都能把输出写入上下文；DSH 依赖声明更显式 | DSH 更优 |
| `{context_var}` | `{{param}}`, `{{step.output}}`, filters | workflow-use 用 Python format；缺 key 时原样返回 | DSH/T-86 的拒错语义更优 |
| `navigation/click/input/select_change/key_press/scroll/go_back/go_forward` | UI `navigate/click/fill/selectOption/setDateTime/waitFor/readValue` | 动作覆盖相近；各有少量差异 | 相当 |
| `extract/extract_page_content` 强制最后一步且需 AI | `assertions`, `postcondition`, extract | workflow-use schema 强制以 AI 提取结束；DSH 可以无 LLM 确认 | DSH 更符合确定性边界 |
| `agent {task,max_steps}` | heal 仅在受控边界运行，无开放 agent step | workflow-use 可在工作流内显式调用 agent | 与 DSH J4 冲突，不借鉴 |
| `verification_checks`, `expected_outcome` | `assertions`, step/skill `postcondition` | workflow-use 支持确定性/AI 校验，但 step verification 默认关闭；DSH 写后条件是运行安全语义 | DSH 更优 |
| `wait_time` | `waitAfter` | 固定时间 vs 事件/状态等待 | DSH 更优 |
| `cssSelector/xpath/elementHash` legacy | Playwright 单引擎 locator | workflow-use 仍保留 legacy 字段 | DSH 更清晰 |
| `selectorStrategies[]` 无强类型 | `LocatorStrategy` discriminated union | workflow-use 可按 priority 尝试 text/role/aria/placeholder/title/alt/fuzzy/xpath；DSH 类型更严格 | 各有所长；不借鉴 XPath/fuzzy |
| `target_text` | Playwright selector + `recordedHint` | workflow-use 以可见/可访问文本为主 | 思路相当 |
| `container_hint`, `position_hint` | `scope`, `produces`, scoped locator | workflow-use 是文本提示且可出现 “item 2 of 3”；DSH 是结构化 scope 因果 | DSH 更优 |
| 无 locator confidence 字段 | `confidence: HIGH/LOW` | workflow-use 变量识别有 confidence，但 locator schema 没有执行门禁 | DSH 更优 |
| 无 `recordedHint` | `recordedHint` | DSH 保存录制时语义与匹配数，可做 T-84 漂移核对 | DSH 更优 |
| 无 risk/side-effect/idempotency | `riskLevel`, `hasSideEffect`, `idempotent` | workflow-use 无写操作安全分类 | DSH 更优 |
| 无请求模型 | `network {method,url,headers,body,extract}` | workflow-use 不建模页面内业务 fetch | 场景差异；企业系统中 DSH 更强 |
| 无四态 outcome | `ExecutionOutcome` 四态 | workflow-use 只有结果 success/error，无法表达“已发送但结果未知” | DSH 关键优势 |
| 无 GET 业务后置条件 | `postcondition` | DSH 可在不确定时查真实业务状态 | DSH 关键优势 |
| 无 `produces`/scope readiness | `produces`, `waitAfter.scopeReady` | DSH 明确动态 DOM 根的因果与就绪 | DSH 更优 |
| 无 preflight | `preflight` | DSH 可在执行前提取/校验运行状态 | DSH 更优 |
| 无 reentry | `reentry` | DSH 只从锚点重跑幂等前缀并锁身份 | DSH 更优 |
| 无 verification 状态机 | `draft/verified/needs_rerecord`、TTL | DSH LOW 首次监督验证可持久化 | DSH 更优 |
| 无条件分支/循环 step | 当前也无条件分支/循环 | 两者确定性 schema 都是线性；workflow-use 的 agent step 不是确定性分支 | 共同缺口；不应在本轮扩约 |
| schema `extra=allow` | Zod 默认剥离未知键 | workflow-use 接受未建模字段，兼容但弱化契约 | DSH 更严格 |

workflow-use 的输入与步骤定义见 [views.py L8-L182](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/schema/views.py#L8-L182)，顶层与输入 schema 见 [L189-L258](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/schema/views.py#L189-L258)。其示例同样是单一路径的线性 UI 步骤：[semantic_form_fill.workflow.yaml](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/examples/workflows/form_filling/semantic_form_fill.workflow.yaml)。

### 1.3 变量提取机制

workflow-use 实际存在三条变量路径：

1. 录制转换阶段的确定性识别器只扫描 `type=input` 的 `value`。它依次使用正则类型识别（email/phone/URL/date/number 等）、字段上下文关键词（name/id/label/placeholder/target_text）和“看起来动态”的启发式评分；默认最低 confidence 为 0.6。[variable_identifier.py L18-L107](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/variable_identifier.py#L18-L107)、[L132-L180](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/variable_identifier.py#L132-L180)
2. 人工可写 `VAR:name:value` marker，工具将其转成 `{name}` placeholder 和 input schema。[variable_extractor.py L100-L210](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/healing/variable_extractor.py#L100-L210)
3. 可选 LLM 按 prompt 从 `value/selectedText/url/task/target_text` 建议变量，并按 `step_indices` 替换完全相等的原值。[variable_extractor.py L25-L97](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/healing/variable_extractor.py#L25-L97)、[L250-L293](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/healing/variable_extractor.py#L250-L293)

核实结论：

- **B1**：规则识别基于“输入值形态 + 控件上下文 + confidence”，另有 marker 和 LLM 建议，不是单一规则。
- **enum**：其 `input_schema.type` 仅 `string/number/bool`，没有 enum 或 label→value 映射。`select_change.selectedText` 可以变量化，但只是字符串替换，不能证明值域正确。
- **B2**：未发现 workflow-use 从网络响应数组构造模板的机制；它不建模业务网络响应，因而不会以 DSH 的路径产生 `{{s4[0].value}}`。但 `position_hint` 明确允许 `item 2 of 3`，仍可能把录制时位置固化到定位语义中，这是另一类位置漂移风险。
- **B3**：未发现“input_schema 已声明但任何步骤未引用”的静态检查。输入运行时只做 presence/type 校验；placeholder 缺 key 时，代码直接返回原字符串，而不是失败。[service.py L495-L540](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/service.py#L495-L540)
- **B4**：T-86 更严格。`enumMap` 约束业务值域，未引用参数报错能发现静默参数化失败，禁止响应数组固定下标能阻断“错得一致”的提交；workflow-use 均无等价机制。
- **B5**：可借鉴但 T-86 未覆盖的护栏有两项：变量候选保留 confidence 与来源（pattern/context/manual/LLM），便于人工审计；区分敏感类型（password/SSN/card）以阻止其 default 或录制值落盘。后者与 workflow-use 待修 PR #169 的现状一起说明，必须借鉴分类思想而不能照搬实现。

### 1.4 失败与回退

事实层：

- 当前 deterministic step 失败后直接抛 `ValueError`；agent fallback 调用是注释代码。显式 agent step 失败同样写明 fallback disabled。[service.py L630-L718](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/service.py#L630-L718)
- `run_with_no_ai()` 只执行确定性步骤，遇到 `type=agent` 直接报错。[service.py L1047-L1113](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/service.py#L1047-L1113)
- README 把自动 agent 接管、自愈更新 workflow 文件列在未完成路线图中。[README L244-L256](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/README.md#L244-L256)

逐项判断：

- **C1**：没有区分“请求未发出”与“结果未知”。其结果模型只有 `status=success` 与可选 `error_message`。[workflow/views.py](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/views.py)
- **C2**：未发现幂等键、写后 GET、提交去重或 side-effect 分类。当前版本因 fallback 未启用，不会由该路径自动重复提交；但也没有安全恢复能力。
- **C3**：README 所述“失败后 agent 接管”若恢复实现，在写步骤上是不安全的，因为 schema 无法知道动作是否已经提交。只有在引入与 DSH C12 等价的 outcome 判定、幂等 postcondition 和写确认后，才可对写操作开放。
- **C4**：未发现运行前/写前人工确认 schema。`verification_checks` 是结果校验，且 `SemanticWorkflowExecutor(enable_step_verification=False)` 默认关闭，不等价于人工确认。[semantic_executor.py L31-L57](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/semantic_executor.py#L31-L57)
- **C5**：评审者判断 DSH 的安全语义是**优势**，不是过度设计。原因不是功能数量，而是 DSH 面向企业内网写单，重复提交请假/审批的容忍度远低于公共网页搜索失败。

### 1.5 会话与认证

- **E1**：录制服务使用固定 `USER_DATA_DIR` 创建 `BrowserProfile`，因此录制浏览器可能复用该目录已有 cookie/session。[recorder/service.py L104-L133](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/recorder/service.py#L104-L133)
- **E2**：未找到“不代替用户登录”的明确契约。schema 没有 entry、identity probe、login marker、credential provider 或登录中断类型；因此无法确认它是否会把录制到的登录步骤当作普通 workflow，也无法证明身份一致性。
- **E3**：未找到会话过期探测、身份切换检测、过期后暂停并等待用户登录、或从幂等锚点重入的实现。`keep_alive=True` 只是让浏览器保持，不是会话有效性保证。

结论：workflow-use 能复用一个浏览器 profile，但“浏览器还活着”与“业务会话仍有效且身份没变”没有契约区分；DSH C16/C21/C22 的边界更完整。

### 1.6 定位与稳定性

- **D1**：新 schema 首选 `target_text`，可附 `container_hint`、`position_hint`，并保存按 priority 排序的 `selectorStrategies`；legacy CSS/XPath/hash 仍保留。strategy 支持 text_exact、role_text、aria_label、placeholder、title、alt_text、text_fuzzy 与 XPath。[schema/views.py L29-L60](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/schema/views.py#L29-L60)、[element_finder.py L29-L169](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/element_finder.py#L29-L169)。没有 locator confidence 的持久化契约。
- **D2**：页面改版时按多 strategy 顺序尝试，并从 browser-use selector map 做可见性与文本核对；失败时当前代码报错。README 所述 LLM 自愈更新文件尚属路线图。
- **D3**：未发现 T-84 等价机制。它会核对当前 target text，但不保存录制时 `RecordedHint` 与匹配数，也没有“locator 仍命中但语义身份改变”时转 `needs_rerecord` 的状态机。尤其 `_validate_element_in_map()` 将 target text validation 注释为 advisory，具体模糊匹配可能接受包含关系。[element_finder.py L214-L280](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/workflows/workflow_use/workflow/element_finder.py#L214-L280)
- **D4**：未发现 MutationObserver 式 DOM 变更因果观测。`container_hint` 是文本上下文，`position_hint` 是位置提示，不等价于 DSH `produces/scopeReady/scope` 的动态根锁定。

评审判断：workflow-use 的多 strategy 思路对公共网页容错有价值，但 XPath、fuzzy 和 advisory text validation 与 T-79/T-84 的确定性约束冲突，不应照搬。DSH 当前定位方案在“避免静默错点”上领先，在“尽量继续跑”上更保守。

### 1.7 多变体处理

- **A1**：在固定 commit 的 schema、示例、README 与当前 issue 中，未找到同一表单多变体的自动分支录制或多录制合并能力。确定性 schema 是线性步骤列表，没有 `if/switch/loop`；只有显式 `agent` step 可以动态探索，但这不是可审计的确定性分支。
- 因此对于“调休没有出差地点、公假出差有该字段”，workflow-use 的现有录制器同样无法从调休一次演示中可靠知道未出现字段、其填写规则和分支条件。实际选择只能是分别录制/生成，或由人手工改 workflow/代码；未找到生产可用的“一次录制自动覆盖所有变体”。
- workflow-use 的宣传 “Record Once, Reuse Forever” 是复用**同一路径的参数值**，不能据此推导为覆盖录制中不存在的页面结构。[README L236-L242](https://github.com/browser-use/workflow-use/blob/891267bb614c0b0821adbb0f7fffc0ebbf045a38/README.md#L236-L242)

## 2. 研究方向总结

以下三项均明确为研究对照，**不在本轮实现范围**。

### 2.1 AutoRPA

论文：[AutoRPA: Efficient GUI Automation through LLM-Driven Code Synthesis from Interactions](https://arxiv.org/html/2605.21082v1)，ICML 2026。

- 机制：ReAct agent 先探索并收集成功轨迹；translator 把 `click(index=2)` 或固定坐标转换为“软编码动作”，即运行时按元素语义属性查找，再执行动作并可加 assertion。例如论文给出的动作先调用 `find_element(text="password", editable=True, target_description=...)`，确认找到后才 `input_text`。[§3.2](https://arxiv.org/html/2605.21082v1#S3.SS2)
- builder 不只是改写单轨迹。它从树状 trajectory bank 检索多条历史轨迹，生成包含条件与循环的 Python RPA function，并在 seen tasks 上验证。[§3.3](https://arxiv.org/html/2605.21082v1#S3.SS3)
- 是否解决 Q1：**部分解决研究问题，不等于一次录制解决。** 第一条轨迹可生成初版，但 robust function 依赖随后更多任务轨迹、检索、验证和反复 refinement。它支持覆盖同一 task type 的多环境/指令变体，代价正是主动收集多轨迹。
- 与 DSH 冲突：构建期依赖开放式 ReAct 探索、MLLM 定位和代码生成，直接冲突 J4 与当前“确定性、无 LLM 执行”边界。其测试期 fallback 在断点续跑或从头重启，也未针对企业写单给出 DSH 四态/幂等后置确认语义。[§3.4](https://arxiv.org/html/2605.21082v1#S3.SS4)
- 开源成熟度：发现公开仓库 [SusuOooo/AutoRPA](https://github.com/SusuOooo/AutoRPA)，README 链接同名论文，当前仅约 2 stars，主要提供 AndroidWorld 研究实现；未见生产 SLA、企业认证/写安全契约或稳定 release。评审定性为可复现实验原型，不是可直接集成的生产组件。

### 2.2 Agent Workflow Memory

论文：[Agent Workflow Memory](https://arxiv.org/html/2409.07429v1)，ICML 2025；代码：[zorazrw/agent-workflow-memory](https://github.com/zorazrw/agent-workflow-memory)。

- 机制：从一个或多个 experience（自然语言指令 + observation/action 轨迹）诱导可复用 workflow，再把 workflow 作为文本 memory 加入 agent prompt，指导后续 action generation。[§2.2-2.3](https://arxiv.org/html/2409.07429v1#S2.SS2)
- 轨迹数量：接口允许一条或多条；但 offline 方案把同一网站的所有训练 examples 拼入 prompt，专门找跨多任务重复出现的子程序，并把示例值抽象成 `{product-name}`。[§2.3](https://arxiv.org/html/2409.07429v1#S2.SS3)。因此 DSH 多录制更像它的输入前提，而不是对立面。
- 产物：workflow 是自然语言状态描述、推理与可执行环境 action 的序列；它作为 agent 指南，不是独立的确定性 RPA 文件。运行时仍由 LLM 观察并决定下一动作，论文也承认 agent 有时难以判断何时应偏离 workflow 指南。[结果分析](https://arxiv.org/html/2409.07429v1#S3.SS1)
- 可借鉴技术：对多条已验证录制做离线聚类，找“至少两步的重复子程序”；将示例特定值替换成显式参数；共享前缀只作为候选建议，必须经人工/回放验证再提升为公共模板。不能直接借用其 prompt-memory 执行，因为这会引入运行时 LLM 决策。

### 2.3 企业 BPM 分级自动化

论文：[Learning Selective LLM Autonomy from Copilot Feedback in Enterprise Customer Support Workflows](https://arxiv.org/html/2604.23855v1)。这是已部署的客服 BPM 系统，不是 DSH 同类开源库。

- 分阶段结构：logging 收集 UI 状态与操作轨迹 → copilot 给建议并收集 accept/override → selective automation 后台执行高置信动作，低置信动作交还操作员并从更新后的 UI 状态继续。与 DSH `draft → supervised verified → 自动运行` **同构于渐进授权原则**，但粒度不同：论文按动作动态弃权，DSH 当前按 skill/LOW 验证状态门禁。[§方法概述](https://arxiv.org/html/2604.23855v1#S2)
- 置信门控：policy 提议动作，单独的 critic 用 `(state, proposed action)` 输出 accept 概率；仅 `score >= τ` 的关键动作自动执行，否则交人。非关键动作可绕过 critic。critic 用 copilot 的 accept/reject 反馈 SFT，论文报告比原 policy confidence 基线的 precision 高 3.84 个百分点。[Appendix C](https://arxiv.org/html/2604.23855v1#A3)
- 阈值如何定：论文只说明 calibrated threshold、可按动作重要性分层，并要求每次滚动重训后重新校准；**没有公开一个可移植的数值 τ 或完整优化公式**。它用 critical-action precision、finalization rejection、corrective intervention、returns、CSAT 等线上 guardrail 监控覆盖率/安全权衡。[Appendix B](https://arxiv.org/html/2604.23855v1#A2)
- 人工回退：高风险动作（发消息、不可逆账户变更）要求显式人工批准；低 confidence/OOD 交给人，按业务 cluster 触发 guardrail 时自动退回 copilot-only。长尾小 cluster 在监督不足前不开放自动化。
- 可吸收之处：把 locator confidence 与业务动作风险分开；记录人类接受/纠正原因而非只有二值结果；按业务变体切片统计成功/干预/漂移；门禁失败只降级为监督模式，不让 agent 擅自接管。实施前提是足量、脱敏的真实生产反馈与业务指标。

## 3. 传统 RPA 实践

- **UiPath**：官方 Studio 文档把 Sequence 作为简单线性 UI 自动化的首选；遇到变化条件则由开发者在 Flowchart/Sequence 中显式加入 `If`、`Flow Decision` 或 `Switch`，并明确建议避免嵌套 If 以保持简单线性。[Workflow Design](https://docs.uipath.com/studio/standalone/latest/user-guide/workflow-design)、[Switch](https://docs.uipath.com/activities/other/latest/workflow/switch-flowchart-builder)。这表明“单流程含分支”和“拆多个线性流程”都正常，分支不是录一次自动推导。
- **Automation Anywhere**：官方文档要求在 Bot 设计器拖入 `If/Else If/Else` 并手工选择条件、放入分支动作；Loop 同样由开发者选择 iterator/while 条件并放入动作。[Using If action](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/enterprise-cloud/topics/aae-client/bot-creator/commands/cloud-using-if-action.html)、[Using Loop action](https://docs.automationanywhere.com/bundle/enterprise-v2019/page/enterprise-cloud/topics/aae-client/bot-creator/commands/cloud-using-loop-action.html)。未见多次录制自动合并成条件分支的官方承诺。
- **Blue Prism**：Choice stage 用多条 yes/no criterion 分流，按顺序命中首个 true 分支；条件由开发者输入、拖变量或用 expression builder 创建。[Choice stage](https://documentation.blueprism.com/bp-7-0/en-us/frmStagePropertiesChoice.htm)。同样是设计时显式建模。

**A2 结论**：传统 RPA 主流是“线性录制/动作设计 + 人工添加显式分支”。简单且独立维护的变体常拆开；共享骨架稳定、分支条件清楚时合成一个流程。没有查到“录制一个不存在字段的变体后自动泛化到全部变体”的成熟标准方案。

**A4 结论**：未能确认行业统一的 skill/流程数量爆点阈值。官方资料给的是结构复杂度建议，而非数量阈值：UiPath 明确建议避免 nested If，并用 Switch 压缩多条件；其 Flow Switch 可承载超过 12 个 case，但这不是“12 个 skill 后必须合并”的维护阈值。建议 DSH 用本项目指标决策：当同一族存在至少 3 个 skill、共享步骤占比高（建议观察值 ≥70%）、且一次修复需要同步修改多个文件时，触发“抽公共片段/评估显式分支”的人工评审；该数值是评审建议，不是业界事实。

## 4. 问题清单逐条回答

### A1

workflow-use 当前面对同一表单多个结构变体，没有确定性 branch schema，也没有多录制合并器。录制中未出现的字段无法被安全推导；实际需分别生成/录制，或人工修改代码/工作流。其 agent generation 能探索新任务，但不是一次录制的确定性泛化。

### A2

传统 RPA 支持单流程内 `If/Switch/Choice`，但分支条件和分支动作通常由开发者在设计器中显式添加。简单变体拆流程、共享骨架稳定时合并分支，二者都属主流工程实践。

### A3

DSH“一变体一 skill”是**权宜之计**：它符合录制系统无法观察不存在元素的客观边界，也比自动猜分支安全；但若长期拒绝公共片段/显式分支，会产生重复维护。现阶段继续该策略合理，不是错误方向。

### A4

未找到业界公认的数量爆点。建议用重复率与同步修改次数触发治理，而不是硬编码行业数字；本报告提出“同族 ≥3 且共享步骤 ≥70%”仅作为内部观察阈值，需用仓库维护数据校准。

### B1

workflow-use 以输入值 pattern、控件上下文关键词和 confidence 识别变量；另支持人工 `VAR:` marker 与 LLM 建议。确定性自动识别主要覆盖 input step，不是任意业务字段的数据流分析。

### B2

未发现其构造响应数组下标模板，因为它没有 DSH network response 数据流。它因此避开 T-86 的同一路径，但 `position_hint=item 2 of 3` 仍会固化 UI 位置，不能视为完全免疫固定下标语义。

### B3

没有找到声明未引用检查。缺失 placeholder 的运行行为是保留原字符串，属于宽松失败，可能把参数错误延迟到页面执行。

### B4

DSH T-86 更严格：enum label/value 显式绑定、声明必须被引用、禁止响应数组固定下标、无法判断则拒绝加载。这些直接防静默错单；workflow-use 主要优化通用复用便利性。

### B5

T-86 可补充“参数候选来源/confidence 可审计”和“敏感变量禁止默认值/录制值落盘”。不建议补 LLM 自动建议；可先用确定性来源标记实现。

### C1

workflow-use 没有 `not_sent` 与 `outcome_unknown` 的区分，只有一般 success/error 结果。

### C2

没有找到写请求幂等、提交去重或写后查询。当前 agent fallback 未启用，所以当前路径不会因 fallback 自动重提；这不是防护，只是能力尚未实现。

### C3

当前代码不会自动 fallback；若按 README 路线图恢复通用 agent 接管，写操作在无法判断是否已提交时可能重复执行，因此不安全。必须先引入四态、postcondition 和写确认，或把 write/critical 排除在 fallback 外。

### C4

没有运行时人工确认状态机。可选 step verification 不是人工确认，且默认关闭。

### C5

DSH 安全语义是**优势**。企业单据的副作用、身份绑定和审计要求足以证明其必要性；不应因为公共网页自动化项目缺少这些机制就判 DSH 过度设计。

### D1

workflow-use 以 `target_text` 为主，附文本容器/位置提示和多 strategy fallback，仍兼容 CSS/XPath/hash。没有 locator HIGH/LOW confidence 契约。

### D2

通过 selector map、semantic strategies、可见性/文本核对和 XPath fallback 抵御改版；全部失败则报错。自动 agent 自愈更新文件仍在路线图。

### D3

没有 T-84 等价的录制语义身份对照与 `needs_rerecord` 状态机；当前文本核对只能发现部分“找不到”，不能系统拦截“仍命中但含义已变”。

### D4

没有找到 DOM MutationObserver 因果观测；文本 `container_hint/position_hint` 不等价于 DSH scope 根的产生与就绪契约。

### E1

录制器用持久 `USER_DATA_DIR` 启动 BrowserProfile，可复用该目录已有登录态；普通 Workflow 也可接受外部传入 Browser。

### E2

未能确认“不代替用户登录”的明确边界；schema 和文档没有对应契约。

### E3

未找到 session probe、过期中断、identity lock 或安全重入机制。

### F1

应该借鉴：参数候选来源/confidence 审计；多录制的公共子程序离线发现；按动作风险分层的人工反馈统计；按业务变体切片的漂移/干预指标。成本见 §5.1。

### F2

值得记录但现在不做：AutoRPA 多轨迹 translator-builder；AWM 工作流归纳；企业 BPM learned critic 与动态阈值；显式条件分支 schema。它们需要多轨迹数据、LLM/训练基础设施或冻结契约变更。

### F3

明确不应借鉴：未知结果上的通用 agent fallback；运行时开放探索；XPath/fuzzy/advisory-only 文本校验；把 reasoning 原文落入 workflow；缺 key 时保留原 placeholder；依赖固定 position hint 覆盖变体。

## 5. 借鉴清单

### 5.1 应该借鉴（可实施）

| 项 | 来源 | 实施成本 | 建议优先级 | 与现有任务的关系 |
|---|---|---:|---|---|
| 参数候选记录 `source/confidence`，输出到分析报告而非执行 schema | workflow-use VariableIdentifier | 低（1-2 人日） | P1 | 可作为 T-86 后续可审计性增强；不改变本轮 enum 契约 |
| 敏感参数类型禁止 default/录制原值落盘 | workflow-use 类型分类 + PR #169 反例 | 中（2-4 人日） | P0 | 加强 C8/C11；需独立安全任务 |
| 基于已验证 skills 的公共两步以上子程序重复检测，只产建议 | AWM | 中（3-5 人日） | P2 | 缓解多录制维护；不自动改 skill |
| 按变体统计 replay 成功、人工干预、漂移/重录率 | 企业 BPM slice-aware operation | 中（3-5 人日） | P1 | 为是否合并变体提供真实阈值 |
| 人工拒绝原因采用分级标签，而非仅通过/失败 | 企业 BPM feedback taxonomy | 低（1-2 人日 schema/UI，另需采集周期） | P2 | 可扩展 LOW/needs_rerecord 诊断；需先做设计评审 |

### 5.2 值得记录但现在不做

| 项 | 来源 | 不应该现在做的理由 |
|---|---|---|
| 多轨迹 translator-builder 自动合成条件/循环代码 | AutoRPA | 引入 ReAct/MLLM/RAG、生成代码与长期验证；冲突 J4，研究实现成熟度不足 |
| 从多 skills 自动归纳公共 workflow memory | AWM | 运行时依赖 LLM；应先积累多变体真实轨迹并只做离线建议 |
| learned critic + 动态 action-level threshold | 企业 BPM | 需要大量脱敏 accept/override 生产数据、校准集和业务 guardrail；当前没有训练前提 |
| DSH 确定性 `if/switch/loop` schema | 传统 RPA | 属冻结契约与执行器扩展，不是 T-86~T-89 范围；需要独立 RFC 与安全语义 |
| supervised → selective automation 的多会话操作台 | 企业 BPM | 产品形态与基础设施扩张过大，需先证明业务量与监督价值 |

### 5.3 明确不应该借鉴

| 项 | 来源 | 理由 |
|---|---|---|
| 写步骤失败后无条件 agent 接管 | workflow-use 愿景 | 不区分 outcome unknown，会重复提交 |
| 缺失 placeholder 时保留原字符串继续跑 | workflow-use 当前实现 | 把静态错误变成运行时或静默语义错误，违反“报错优先” |
| XPath、fuzzy locator、advisory-only 文本校验 | workflow-use | 与 T-79/T-84 决策冲突，增加错点而非明确失败 |
| 将 `workflow_analysis` 推理文本随工作流落盘 | workflow-use | 非执行所需，可能包含 PII/业务上下文，扩大泄漏与审计面 |
| 运行时开放式 ReAct 探索 | AutoRPA/AWM | 与 J4 和无 LLM 确定性执行边界冲突 |
| 单次录制自动猜测未出现字段/分支 | 营销式“record once”推论 | 外部项目与论文均未证明该能力可在生产可靠实现 |

## 6. 与 T-86~T-89 的冲突

**无需要中止开发的冲突。**

- T-86 的 `enumMap + 未引用参数报错 + 禁止响应固定下标` 比 workflow-use 更严格，有直接安全依据，应继续。
- T-87 用 request value/DOM 因果关联比外部项目的线性 UI 录制更适合 DSH network channel，无冲突。
- T-88 的四态与直连 `status=null` 验证正是 workflow-use 缺失的安全边界，应继续。
- T-89 把审计做成跨平台脚本，与外部项目活跃但主路径仍可能失效的事实相呼应，无冲突。

潜在未来冲突只记录不调整：如果后续采用 AutoRPA/AWM 或 workflow-use agent fallback，将直接触及 J4、C6、C12、C16 与 T-79 §12；必须另立 RFC，不能作为 heal 的自然扩展混入。

## 7. 对现有架构的最终判断

- DSH 的多录制策略：**权宜之计**。现阶段是正确、安全的权宜方案；未来应以已验证的多录制为输入，做“公共片段候选 + 人工合并”，而非一次录制自动猜全变体。
- DSH 的安全语义：**优势**。四态 outcome、写后确认、身份锁、会话中断与人工验证均有外部方案未覆盖的企业写操作依据。
- DSH 的定位方案：**领先**（按避免静默错单的目标）。workflow-use 的 selector fallback 更激进，但没有 T-84 等价漂移状态机，也未持久化 locator confidence。
- 需要调整的方向：**不调整 T-86~T-89**。后续可独立加入参数候选 provenance、敏感变量落盘禁令、变体维护指标与公共片段离线发现；不扩展运行时 LLM、分支 schema 或自动 agent 接管。

### 证据边界

本报告未运行 workflow-use 的浏览器 E2E，也未对三篇论文复现实验；项目行为结论来自固定 commit 的 schema、执行路径、示例、README 与公开 issue/PR，论文结论来自论文正文。未找到的能力均写为“未找到/未能确认”，不据此证明其永远不存在。传统 RPA 部分只引用 UiPath、Automation Anywhere 与 Blue Prism 官方文档；未找到行业统一流程数量阈值。
