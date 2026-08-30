# 技能 YAML 编写与修正

## 基本结构

技能包含 `skill`、`params`、`preflight`、`steps`、`assertions`，写操作还应提供 step 或全局 `postcondition`。修改后用 CLI dry-run 或 `parseSkill()` 校验，不能依赖 YAML 能被读取就认为契约正确。

```yaml
skill:
  id: oa_overtime_submit
  name: 提交加班申请
  system: oa
  baseUrl: https://oa.example.internal
  version: 1
params:
  - name: type
    type: enum
    values:
      - { label: 工作日加班, value: workday }
    required: true
steps: []
assertions: []
```

枚举运行参数传 `label`，请求模板用 `{{type|enumValue}}` 转成真实接口值。不要把动态 token、审批人 id 或会话值写死在 YAML。

## 参数与模板

- 参数类型：`string`、`number`、`date`、`datetime`、`enum`、`boolean`。
- 普通参数：`{{reason}}`。
- preflight 变量：`{{csrfToken}}`。
- 跨步骤结果：`{{approver.approvalToken}}`。
- 枚举值：`{{type|enumValue}}`。
- 日期格式：`{{startTime|date:YYYY-MM-DD}}`。

模板变量缺失必须报错；不要用空字符串掩盖录制或依赖分析缺陷。

## 通道与步骤

- `network`：页面内 `fetch` 执行，同源 Cookie 自动携带。
- `ui`：通过语义定位器执行页面动作。
- `merged`：只把参数或前序结果写入执行上下文，不操作页面。
- `auto`：先按网络规则执行，只在明确 `not_sent` 等安全条件下考虑 UI 降级。

`riskLevel` 为 `read`、`write`、`critical`；真正改变业务数据的步骤同时设置 `hasSideEffect: true`。写操作不得因超时或响应丢失自动重复。

## 定位器优先级

优先使用 `el-form-item`、`el-option`、`el-dialog-scoped`、`el-table-cell`、稳定 `text`、`role`，最后才用 `css`。不要复制构建 hash 类名或 `nth-child`。对弹窗按钮使用 `el-dialog-scoped`，避免命中页面同名按钮。

## Preflight 与断言

preflight 支持当前 DOM、请求 HTML、请求 JSON 和 regex 提取。Legacy SSR 的 `__VIEWSTATE` 等隐藏字段必须从当次真实 HTML 获取。

断言支持 `httpStatus`、`jsonPath`、`textPresent`、`regexExtract`。有副作用步骤应增加幂等 GET postcondition，用能唯一标识本次业务的参数匹配最近记录。

## 环境生成值的限制

提交时才由页面脚本或运行环境生成、且无法从当前 DOM、preflight、响应或前序步骤稳定提取的值（例如随机标识、设备派生标识、提交时刻时间戳），当前不支持自动重现。

- Analyzer 会将无法溯源的请求叶子写为 `TODO_UNRESOLVED`。
- 含该占位符的技能会在产生副作用前拒绝执行，不会提交录制时字面量。
- 不要把随机数、时间、浏览器特征或 fixture 里的生成方式硬编码进通用技能。
- 只有业务契约明确允许调用方提供时，才可人工改为公开参数；能够从页面或响应稳定读取时，应显式配置为内部提取值。

## 发布检查

- [ ] 所有 `# TODO` 已人工复核。
- [ ] 参数名、枚举 label/value 与接口字段一致。
- [ ] 动态值来自 preflight 或前序步骤 extract。
- [ ] 写步骤风险、确认与 postcondition 完整。
- [ ] UI 与 network 通道分别验证。
- [ ] rebuild 后仍能回放，YAML 可被 `parseSkill()` 解析。
