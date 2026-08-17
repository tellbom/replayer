# 公网 Mock 到内网迁移清单

迁移顺序固定为：先只跑 UI 通道，再重新录制真实接口，最后才启用 network 通道。

## 环境差异

- [ ] 确认真实登录方式；公网为表单登录，内网 SSO/AD 按认证 A/B/C 分类配置。
- [ ] 录制真实 CSRF 获取方式；确认是 meta、Cookie-to-Header、隐藏字段或无需 CSRF，并生成对应 preflight。
- [ ] 执行 `dsh doctor --probe-frontend <url>` 确认 Vue 与 Element 版本；只有证据为 Vue2 + Element UI 2.x 时才启用条件兼容任务。
- [ ] 测量页面与接口加载时间，并据实设置 timeout，禁止沿用本地毫秒级假设。
- [ ] 将技能 `baseUrl` 与接口 path 改为真实系统地址，逐项复核跨域和反向代理路径。
- [ ] 确认真实浏览器版本及企业策略兼容性。
- [ ] 配置并验证内网代理或 PAC；无代理时明确记录。
- [ ] 将 LLM 配置切换到获准的内网或公网兼容端点，验证无视觉模型路径。

## 运行时载体

- [ ] Chrome 已安装，记录版本；验证 Playwright `channel: 'chrome'` 可启动。
- [ ] 若强制国产浏览器，确认是否为 Chromium 内核并记录 `executablePath`；IE 内核列为不支持并升级决策。
- [ ] 检查 Chrome Enterprise Policy 是否禁用 `--remote-debugging`。
- [ ] 判定认证类型：A Kerberos/NTLM、B 表单登录、C 客户端证书。
- [ ] 确认是否需要内网代理或 PAC，并验证目标 OA 与认证域均可达。
- [ ] 枚举强制浏览器安全插件，验证其是否拦截脚本注入、弹窗、下载或同源请求。

## 业务安全验收

- [ ] 写操作逐步确认 `riskLevel`、`hasSideEffect` 与 postcondition。
- [ ] postcondition 使用真实只读业务查询，不引用 `/_debug/*` 测试接口。
- [ ] 模拟响应丢失，确认 outcome 为 `outcome_unknown` 或由 postcondition 收敛，且业务数据只增加一次。
- [ ] 验证 401 才进入登录恢复；403 直接 forbidden，不进入登录循环。
- [ ] 对录制产物、诊断包和 LLM trace 搜索真实 Cookie、Authorization、password、token，确认均已脱敏。
- [ ] 完成 UI 通道回放后重新录制真实接口，复核动态 token 和跨请求依赖，再开启 network 通道。
