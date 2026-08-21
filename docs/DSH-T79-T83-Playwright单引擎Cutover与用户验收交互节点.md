# DSH Browser Skill · Playwright 单引擎 Cutover 与用户验收交互节点
版本：v1.0
日期：2026-08-21
用途：交付 Codex 继续开发

## 0. 本轮产品裁决

DSH Browser Skill 的 Locator 产品边界正式调整为：

> 优先使用 Playwright 原生 Locator Generation。页面具备足够语义时生成稳定 Locator；页面缺乏语义、只能产生 nth/位置型 Locator 时，允许生成 LOW Skill，由用户在首次执行时监督并确认。页面后续发生明显结构变化导致 Skill 错位或失效时，允许重新录制，不承诺自动理解所有前端框架和所有 DOM 改版。

### 明确决策

1. `playwright` 成为唯一目标 Locator Engine。
2. `legacy` 不再作为长期主引擎维护。
3. 不新增 Element UI / Element Plus / Ant Design / Arco 等框架强适配定位规则。
4. 不要求解决 G3 为 HIGH；`textbox >> nth=N` 可以作为 LOW 产物存在。
5. 不使用 XPath。
6. 不自研 DOM similarity、Sibling scoring、Framework semantic learning。
7. LOW 允许执行，但 Skill 首次完整运行必须由用户监督并确认。
8. Skill 经用户确认后可进入 `verified` 状态。
9. 后续 Locator `NOT_FOUND`、strict multiple、页面流程明显改变时停止并提示重新录制。
10. 不承诺在页面重大改版后保持原 Skill 正确。

## 1. T-79 产品契约调整

修改 Locator Cutover 标准、Skill verification 状态、LOW 合法性和首次验证要求。

要求：
- G3 LOW 不再阻止 Playwright Cutover。
- LOW 不得伪装成 HIGH。
- 所有 LOW 必须进入首次验证流程。
- 文档明确重大页面变化需要重录。
- 单独 commit。

## 2. Locator 质量契约

### HIGH
Playwright 生成后具备稳定语义且无明显位置依赖，例如：
- `getByRole('button', { name: '提交' })`
- `getByRole('textbox', { name: '申请原因' })`
- 具名 scope 内的唯一控件

### LOW
允许：
- `getByRole('textbox').nth(5)`
- `getByRole('button', { name: '搜索' }).nth(2)`
- 其它位置型 selector

必须记录：
```yaml
confidence: LOW
recordedHint:
  action: fill
  visibleText: 开始时间
```

`recordedHint` 仅用于提示、日志、首次验证和诊断，不得偷偷转成框架特化 Locator。

## 3. Skill 生命周期

状态：
- `draft`
- `verified`
- `needs_rerecord`

规则：
- 新 Skill 默认 `draft`
- 含任意 LOW：`requiresFirstRunVerification=true`
- 用户完整监督执行并确认正确后：`draft -> verified`
- Locator 0 match、strict multiple、关键结构不存在或流程明显变化：`needs_rerecord`

## 4. Recorder 完成后的交互

录制结束显示：

```text
Skill：提交加班申请
共 12 个步骤
稳定定位：10
位置型定位：2

⚠ 此 Skill 包含 2 个 LOW 步骤，首次运行需要人工监督。
```

LOW 明细示例：

```text
步骤 4
动作：填写
录制提示：开始时间
Locator：
getByRole('textbox').nth(5)

风险：
该步骤依赖页面控件顺序。
```

按钮：
- 开始首次验证
- 重新录制
- 取消

本阶段不开发复杂手工编辑 Locator 页面。

## 5. 首次运行验证交互

含 LOW 时，执行前提示：

```text
此 Skill 包含位置型 Locator。

首次执行请保持浏览器可见，并确认每一步操作位置正确。

DSH 不保证位置型 Locator 在页面改版后仍指向原控件。
```

按钮：
- 开始验证运行
- 取消

运行期间不要每一步暂停，只显示 LOW 步骤风险并提供“停止执行”。

完整执行结束：

```text
Skill 首次验证完成
请确认本次所有操作是否正确。
```

按钮：
- 确认正确
- 发现错误

确认正确后写入：
- `verifiedAt`
- `verifiedRunId`
- 如已有用户标识则记录 `verifiedBy`

发现错误：
- 保持 `draft`
- 提供重新录制入口
- 不做自动修复

## 6. verified Skill 后续运行

verified 后 HIGH/LOW 均允许正常自动运行。

仍必须机械停止：
- 0 matches
- strict multiple
- frame 不存在
- scope/dialog 不存在
- 关键动作执行失败

禁止 `.first()` 静默选第一个。

对于“页面变化后 nth 仍唯一但语义已错位”的情况，本阶段接受为产品限制，不开发复杂自动语义纠错。

## 7. LLM 边界

本轮 Cutover 不依赖 LLM Locator Heal。

LLM 可以保留已有能力，但：
- 不是 Cutover blocker
- 不是 LOW -> HIGH 必经路径
- 不是 Skill 正确性的保证层

默认产品流程：
```text
Playwright HIGH -> 使用
Playwright LOW -> 用户首次验证
运行期结构失败 -> 停止 / 重录
```

禁止本轮顺手增强 LLM Heal。

## 8. T-80 Playwright 默认 Cutover

将：
```text
DSH_LOCATOR_ENGINE default:
legacy -> playwright
```

要求：
- 默认行为与显式 `playwright` 一致
- 暂时保留 `legacy` 作为回滚路径
- 不删除 legacy
- 重跑 T68、T69、T71、T72、T73、T74 及全量测试
- 新验收标准不是“全部 HIGH”，而是：
  - HIGH 必须真的 HIGH
  - LOW 必须如实 LOW
  - 所有场景按其质量等级完成录制/回放

## 9. T-81 首次人工验证状态机

实现：
- `draft`
- `verified`
- `needs_rerecord`
- `requiresFirstRunVerification`
- `verifiedAt`
- `verifiedRunId`

若当前没有完整 Web UI，先做 CLI：

```text
This skill contains 2 LOW-confidence locators.
Run supervised verification? [y/N]
```

结束后：

```text
Was the complete run correct? [y/N]
```

## 10. T-82 legacy 移除 Gate

T80/T81 全部通过后，以 Playwright 默认模式重跑：

1. 全量 unit
2. 全量 e2e
3. T68
4. T69
5. T71
6. T72
7. T73
8. T74
9. 至少 3 条真实完整 Skill 流程

如果：
- 无真实业务能力必须依赖 legacy
- LOW 已按新契约进入验证
- Playwright 动态矩阵继续通过
- 没有新的硬 blocker

则 `GO`，进入 T83。

否则 `NO-GO`，必须明确列出哪个真实功能仍只能靠 legacy。

禁止仅因为 Element Plus G3 LOW 判 NO-GO。

## 11. T-83 删除 legacy

仅 T82=GO 执行。

删除：
- legacy generator 主路径
- `DSH_LOCATOR_ENGINE=legacy`
- legacy 专属 resolver / dead branch
- legacy-only tests

如果某段旧代码属于通用执行能力而不是框架定位特判，可以保留。

不要保留：
```text
if ElementPlus ...
if el-form-item ...
```
仅为了把 LOW 强行变成 HIGH。

如果切换变量已无意义，最终删除 `DSH_LOCATOR_ENGINE`，系统只保留 Playwright Locator Engine。

## 12. 禁止扩范围

T79-T83 期间禁止新增：
- Element UI/Plus 强适配
- Ant Design/Arco Adapter
- XPath
- Visual Locator
- DOM similarity engine
- sibling scoring
- framework detection
- 自动页面改版迁移
- 新 Keycloak 能力
- 新 Session 策略
- storageState
- J4 自动探索

当前任务只有：
```text
Playwright 单引擎
+ LOW 用户验收
+ legacy 退出
```

## 13. 必须新增的交互测试

### V1 全 HIGH Skill
录制并运行成功，不触发 LOW 风险流程。

### V2 含 LOW
录制后：
- `confidence=LOW`
- `requiresFirstRunVerification=true`

### V3 LOW 首次确认
监督运行成功 + 用户确认：
- `verified`

### V4 LOW 首次否认
监督运行成功 + 用户选择“发现错误”：
- 仍为 `draft`

### V5 verified 后运行
不重复要求首次确认。

### V6 Locator 不存在
`matchCount=0`：
- 停止
- `needs_rerecord`

### V7 strict multiple
多匹配：
- 停止
- 禁止 `.first()`

### V8 LOW 位置变化仍唯一
人为改变页面，使 nth 命中另一控件。
本测试不是要求自动发现，而是记录：
`Accepted product limitation`

防止后续 Agent 再把它扩成复杂自愈任务。

## 14. T-82 最终报告格式

```text
Playwright 默认模式：
unit:
e2e:

T68:
T69:
T71:
T72:
T73:
T74:

HIGH steps:
LOW steps:

LOW supervised verification:
PASS / FAIL

是否仍存在只能由 legacy 完成的真实业务能力：
YES / NO

如 YES：
逐项列文件、场景、原因。

Cutover:
GO / NO-GO
```

## 15. 最终目标架构

```text
Recorder
  ↓
Playwright Locator Engine
  ├─ HIGH → Skill
  └─ LOW  → First-run Verify → Skill
                        ↓
                Playwright Replay
                  ├─ Success → Result
                  └─ Structural Fail → Re-record
```

最终不再存在：
```text
Playwright Engine vs Legacy Engine
```

## 16. Codex 执行规则

1. T79-T83 每个节点独立提交。
2. 不提前执行下一节点。
3. T82 必须停下来输出 GO/NO-GO。
4. T82 未 GO，禁止删除 legacy。
5. 不修改旧 T75 报告来适配新标准；T75 是旧契约下的正确历史结论。
6. 新产品契约从 T79 开始留下明确 Git 证据。
7. 不为了让测试变绿而把 LOW 升成 HIGH。
8. 不新增框架特化来“补”G3。

最终目标：

> 用 Playwright 作为唯一通用 Locator Engine。稳定语义自动使用；无稳定语义时允许位置型 LOW Locator，由用户首次监督验证。页面重大变化后允许重新录制，以清晰的产品边界换取更低框架耦合和更低系统复杂度。
