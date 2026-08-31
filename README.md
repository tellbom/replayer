# DSH Recorder

DSH Recorder 把浏览器中的 OA 操作录制为可审查的 YAML 技能，并通过页面内同源请求或语义 UI 定位器确定性回放。LLM 只用于意图路由、草稿标注和定位失败后的候选修复，不直接自由操作页面。

当前录制器只有一条 Canonical IR 路径；正常使用无需也不能选择 legacy 录制模式。

## 环境要求

- Node.js 22 或更高版本
- npm 11
- 已安装 Google Chrome

```powershell
npm install
npm run build
npm test
```

## 启动 Mock OA

打开两个终端：

```powershell
npm run start --workspace mock-oa-backend
```

```powershell
npm run dev --workspace mock-oa-frontend -- --host 127.0.0.1
```

访问 `http://127.0.0.1:5173/login`，测试账号和密码均为 `tester`。

## 标准使用流程：浏览器会话常驻

每天开始工作时先启动一次常驻会话，并在弹出的浏览器中自行完成登录：

```powershell
npm run dsh -- session start --entry <系统>
```

之后的录制和回放会优先附着该浏览器。录制示例：

```powershell
npm run dsh -- record --entry <系统> --out ./tmp/rec1
```

使用期间请勿关闭该浏览器窗口。这是保持会话的使用前提：短期子系统会话失效后，需要依靠仍然存活的浏览器会话重新认证。需要并行操作时，请在同一浏览器中打开新标签页。

```powershell
npm run dsh -- session status --entry <系统>
npm run dsh -- session stop --entry <系统>
```

若 entry 同时配置 `expectedPortalTtlMs` 与 `warnBeforeExpiryMs`，`session status` 会按配置显示估算提醒；字段缺失时不产生阈值提醒。估算值不参与登录状态判断，实际有效性始终以 `sessionProbe` 为准。

默认检测到常驻会话时只附着、不关闭 owner。只有明确接受会话丢失时才可使用 `--force-takeover`。

## 录制与生成技能草稿

```powershell
npm run dsh -- record --entry <系统> --out ./tmp/rec1
```

在打开的 Chrome 中完成业务操作，回到终端按 Enter 结束。生成确定性草稿：

```powershell
npm run dsh -- analyze ./tmp/rec1 --out ./skills/my_skill.yaml
```

若有两次仅业务参数不同的录制，可增强参数识别：

```powershell
npm run dsh -- analyze ./tmp/rec1 --compare ./tmp/rec2 --out ./skills/my_skill.yaml
```

需要 LLM 标注时配置 `.env.example` 中的 `DSH_LLM_*` 环境变量，再增加 `--llm`。LLM 标注均带 `# TODO`，发布前必须复核。

## 回放

先查看计划，不启动浏览器：

```powershell
npm run dsh -- replay ./skills/oa_overtime_submit.yaml --params '{"type":"工作日加班","startTime":"2026-08-19 18:00:00","endTime":"2026-08-19 21:00:00","reason":"版本上线"}' --dry-run --no-llm
```

执行回放；写操作会要求确认：

```powershell
npm run dsh -- replay ./skills/oa_overtime_submit.yaml --params '{"type":"工作日加班","startTime":"2026-08-19 18:00:00","endTime":"2026-08-19 21:00:00","reason":"版本上线"}' --no-llm
```

参数也可传 JSON 文件路径。`--channel ui` 或 `--channel network` 可强制通道；自动化验收才使用 `--yes` 跳过交互确认。

## 自然语言运行

配置 `DSH_LLM_BASE_URL`、`DSH_LLM_API_KEY`、`DSH_LLM_MODEL` 后执行：

```powershell
npm run dsh -- run "帮我提交工作日加班，开始 2026-08-19 18:00:00，结束 2026-08-19 21:00:00，事由是版本上线"
```

无匹配技能时返回 `NO_MATCHING_SKILL`，不会进入开放式探索。完全禁用 LLM 时必须确定性指定技能或精确技能 id：

```powershell
npm run dsh -- run oa_overtime_submit --no-llm --skill ./skills/oa_overtime_submit.yaml --params '{"type":"工作日加班","startTime":"2026-08-19 18:00:00","endTime":"2026-08-19 21:00:00","reason":"版本上线"}'
```

## 自检与验收

```powershell
npm run dsh -- doctor
npm run dsh -- doctor --probe-frontend http://127.0.0.1:5173/overtime/apply
npm run build
npm test
npm run lint
npm run e2e
node scripts/a3-loop.mjs
```

技能编写见 [docs/skill-authoring.md](docs/skill-authoring.md)，内网落地见 [docs/migration-checklist.md](docs/migration-checklist.md)，失败诊断见 [docs/troubleshooting.md](docs/troubleshooting.md)。
