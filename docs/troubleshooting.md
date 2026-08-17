# 排障指南

## 先看诊断包

失败运行会在 `runs/<run-id>/` 生成诊断包。按以下顺序查看：

1. `result.json`：失败步骤、outcome、通道和错误码。
2. `step-*-snapshot.txt`：提供给定位器/LLM 的紧凑语义快照。
3. `step-*-dom.html`：失败时脱敏后的 DOM。
4. `step-*-before.png` 与 `step-*-after.png`：动作前后页面状态。
5. `network.har`：document/XHR/fetch 请求、状态和时序。
6. `console.log`：页面控制台错误。
7. `llm-trace.jsonl`：模型输入、输出、耗时和 token 估算，文本已脱敏。

## 常见失败

### `LOCATOR_NOT_FOUND`

比较 snapshot 中的 label/按钮文案与技能 target。优先改为语义定位器；自愈候选必须唯一、可见、enabled、动作类型兼容。resolve-only 阶段不会 click/fill，只有动作验证成功后才允许写回。

### `outcome_unknown`

这表示请求可能已到达服务端，但客户端未拿到可信响应。禁止直接重试或自动切 UI。必须执行幂等 GET postcondition：查到记录则收敛为成功；明确未查到且规则允许时才可重新确认后降级；无法判断则停止并保留诊断包。

### 403 Forbidden

403 表示已识别身份但无权限，不等同于会话过期。系统不会进入登录握手，也不会重试业务动作。检查账号权限、目标接口和代理授权。

### 登录恢复

401、登录跳转或登录页 DOM 才进入恢复流程。恢复只重新建立会话；写操作恢复后仍需再次确认，不能把认证恢复当作自动重放授权。若一直超时，检查 `sessionApi`、`loggedInJsonPath`、登录 URL/DOM 标记和企业 SSO 策略。

### 重复提交保护

检查步骤是否 `hasSideEffect: true`、是否配置真实业务 postcondition，以及诊断结果是否为 `not_sent`、`confirmed_failure` 或 `outcome_unknown`。只有机械证据证明请求未发出时才允许安全降级；响应丢失不能视作未发送。

### 脱敏

录制、诊断与 LLM trace 都必须通过 sanitizer。`sanitizeMode: fallback` 表示结构化解析失败，应先修复内容类型或解析规则；不要把它当作已可靠脱敏。交付前搜索 Authorization、Cookie、password、token 与测试 secret，环境密钥只通过环境变量注入。

## 快速命令

```powershell
npm run dsh -- doctor
npm run dsh -- replay ./skills/<skill>.yaml --params ./params.json --dry-run --no-llm
npm run build
npm test
npm run lint
npm run e2e
```
