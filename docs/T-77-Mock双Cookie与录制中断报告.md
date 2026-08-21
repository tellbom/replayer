# T-77 Mock 双 Cookie 与录制中断报告

## 结论

T-77 放行。Mock OA 默认使用 session cookie，并可通过 `POST /api/login?cookieMode=persistent` 切换为持久 cookie。录制器会按 entry 的 `probeIntervalMs` 巡检当前会话，失效后停止动作和网络录制、保存 partial 文件、等待用户恢复登录并校验身份。

## 中断状态机

会话探测失败后按以下顺序执行：

1. 将页面录制状态置为暂停，网络监听同步暂停。
2. 等待当前动作的 mutation/scope 后处理完成并清空旧 scope 状态。
3. 写入 `record.partial.json`，加入 `session-interrupt` 标记。
4. 显示登录提示并调用 `ensureEntry`；不会填写登录表单或提交凭证。
5. 登录恢复后比较开始录制时的 `identityDigest`。
6. 同身份时重新注入当前文档的 recorder probe，恢复录制并提示页面状态可能已重置。
7. 身份变化时立即结束，`record.json` 与 partial 文件均标记 `identityChanged`。

登录期间 `__DSH_RECORDING__` 保持 false，网络监听也关闭，因此登录字段、登录按钮和 `/api/login` 不会进入录制产物。

## 分析器行为

`RecordSession.interruptions` 保存：

- `type: session-interrupt`
- `atActionIdx`
- `detectedAt`
- 同身份恢复时的 `resumedAt`
- 异身份时的 `identityChanged`

分析器在 `_notes` 中写出断点对应的 `reentry.anchor` 候选和人工复核提示。断点后的第一个动作会移除旧 `requires` 与 UI scope，不继承中断前已消失的动态根。

## 验证证据

- Mock 单测验证：默认/session 响应不含 `Expires/Max-Age`，persistent 响应包含持久属性。
- Chrome 实测验证：session cookie 的 `expires=-1`，关闭并复用 profile 后会话丢失；persistent cookie 的 `expires>0`，复用 profile 后会话仍有效。
- 中断实测验证：先完整录入 7 个动作后使会话过期，7 个动作均保留；同身份恢复后可继续录制并生成 `resumedAt`。
- 登录页字段和登录请求未进入 `record.json`。
- 换成 `other-user` 登录后录制立即结束，partial 文件保留且标记 `identityChanged`。
- 分析器单测验证断点后的首动作不携带旧 scope，并生成 anchor 候选说明。

整库单测共 143 项，其中 142 项在并发运行时通过；既有 CDP 浏览器测试在 5 秒门限下发生一次资源竞争超时，单独复跑 1/1 通过。T77 浏览器验收 3/3 通过。
