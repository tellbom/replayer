# DSH 系统 · 企业内网 AI 自动化技术调研与实施方案

> 版本：v1.0 ｜ 日期：2026-08-17
> 适用范围：基于 DeepSeek 的 DSH 平台，MCP 工具层 与 AI Page Agent（浏览器智能体）两条并行开发线
> 本文档目标：给出可直接落地的技术选型、架构设计与开发任务分解，交由 AI 编码助手（GPT/Claude Code）实施

---

## 0. TL;DR — 结论先行

1. **不要在"通用 AI Page Agent 直接点 Vue 页面"这条单一路线上死磕。** 纯 LLM + 截图/原始 DOM 的点击方案在企业内网系统上的稳定性天花板很低（2026 年公开基准里，涉及登录/表单/多步流程的真实任务，业界最好成绩也只有 **64.4%** 左右，而且是基准共同作者自己刷的分）。以这个成功率跑生产业务是不可接受的。

2. **正确的解法是"分层降级 + 技能固化"混合架构**，四级执行通道，优先级从高到低：
   - **L0 真实 API**（有 API 的系统）→ MCP 薄层封装
   - **L1 前端私有接口重放**（关键突破口）→ 抓包发现 XHR/Form POST → 生成 OpenAPI → 自动生成 MCP 工具
   - **L2 结构化 UI 操作**（Accessibility Tree / 语义 DOM 压缩 + 编号引用）→ Playwright MCP 范式
   - **L3 视觉 grounding**（截图 + VL 模型定位坐标）→ Midscene.js / UI-TARS 范式，专治 canvas、无语义 div、iframe
   - **L4 人工接管**（Human-in-the-loop）

3. **关于"C# MVC / JSP 没有 API"这个判断需要纠正**：没有 REST API ≠ 没有 HTTP 接口。JSP 和 ASP.NET MVC 的每一次表单提交、每一次局部刷新，本质都是可被重放的 HTTP 请求（Form POST / `__VIEWSTATE` / Struts action / `.do` / `.ashx`）。**L1 层的价值被严重低估**，它往往能覆盖 40–60% 的高频业务动作，且执行是毫秒级、零 token、100% 确定性的。这是本方案中投入产出比最高的一块。

4. **Vue 的 `div` + hash class/GUID 问题，本质不是"LLM 不会点"，而是"没人给它稳定的锚点"。** 有 8 种工程手段可解（见 §5），其中对 Vue 特别有效的是：**运行时可访问性注入（AX Polyfill）** + **文本锚点向上寻找可点击祖先** + **直接事件派发绕过 CSS 选择器**。

5. **技能缓存（Skill Cache）是成本与稳定性的胜负手。** 让 Agent 第一次用"慢通道"（LLM 探索）跑通，然后把成功轨迹固化成确定性脚本/API 调用，之后 99% 的执行走"快通道"。这是 Stagehand、Midscene 缓存机制、Skyvern 工作流的共同思路，也是唯一能把企业内网自动化做到可运维的路径。

6. **模型选型**：DeepSeek V4 系列做"大脑"（规划、推理、工具调用），但**视觉 grounding 需要单独配一个 VL 模型**。DeepSeek 的多模态能力（"以视觉原语思考"框架，V4-Flash 为语言主干 + 自研 ViT）在 2026 年 5–6 月才开源/上线，官方视觉 API 开放节奏仍需确认；生产上建议用 **UI-TARS / Qwen3-VL / GLM-5V** 之一做私有化部署的 grounding 专用模型，与 DeepSeek 主脑解耦。

---

## 1. 背景与问题定义

### 1.1 现状

| 维度 | 现状 |
|---|---|
| 基座模型 | DeepSeek 系列（DSH 平台） |
| 方向一 | MCP 薄层，封装真实 API 供 Agent 调用 |
| 方向二 | AI Page Agent，直接驱动浏览器操作网页 |
| 目标环境 | 企业内网系统（非公网） |
| 已暴露问题 | Vue 前端大量语义化缺失的 `div`，class 名为构建期哈希/GUID，LLM 无法稳定定位与点击 |
| 阻塞点 | 部分老系统（C# ASP.NET MVC、JSP/Struts）无 REST API 可封装 |

### 1.2 问题的技术根因拆解

Vue（以及 React/Angular）SPA 让 UI 自动化困难的具体原因，必须逐条拆开看，因为**每一条对应不同的解法**：

| # | 根因 | 表现 | 影响的定位方式 |
|---|---|---|---|
| R1 | 语义标签缺失 | 按钮是 `<div class="x7f2a" @click>` 而非 `<button>` | 破坏 AX Tree、破坏 `getByRole` |
| R2 | class 名哈希化 | CSS Modules / scoped style 产生 `_btn_1x9km_12` | 破坏 CSS 选择器 |
| R3 | 动态 id/GUID | `id="el-collapse-2f8c-..."` 每次渲染变化 | 破坏 id 选择器 |
| R4 | 深层嵌套 | Element-Plus / Ant Design 一个按钮 8 层 div 包裹 | 破坏 XPath 结构路径 |
| R5 | 虚拟滚动 | 表格只渲染可视区行，目标行不在 DOM 中 | 破坏一切 DOM 方案，需先滚动 |
| R6 | Shadow DOM / iframe | 组件库或嵌套老系统页面 | 破坏跨文档查询 |
| R7 | 异步渲染 | 点击后 200ms 才出现的弹窗 | 破坏"快照-决策-执行"的时序 |
| R8 | 无障碍属性缺失 | 没有 `aria-label`、`role`、`name` | AX Tree 节点变成无名 `generic` |

**关键洞察**：R1/R8 才是 AX Tree 方案在 Vue 系统上失效的真正原因，而不是 R2/R3。如果前端能补上 `role` + `aria-label`（或 `data-testid`），Accessibility Tree 方案的稳定性会**立刻**跳到可用水平——这是成本最低的一次性投入。

---

## 2. GitHub 现成框架调研

### 2.1 类别 A：MCP 浏览器控制层（协议层，无自主决策）

| 项目 | 仓库 | 语言 | 核心机制 | 对本项目的价值 |
|---|---|---|---|---|
| **Playwright MCP** ⭐ 首选 | `microsoft/playwright-mcp` | TS | **Accessibility Snapshot + ref 引用**：返回 YAML 结构树，每个可交互元素带 `[ref=e5]`，LLM 用 `browser_click{ref:"e10"}` 操作，不需要视觉模型、不猜坐标 | 直接解决"LLM 拼不出选择器"的问题——**它根本不需要选择器**。是 L2 层的事实标准 |
| **Playwright CLI** | `@playwright/cli` | TS | 快照落盘到文件，Agent 只拿 `e15` 这类紧凑引用 | 官方基准显示比 MCP 模式省约 **4x token**。长流程/大表格页面强烈推荐 |
| **Chrome DevTools MCP** | `ChromeDevTools/chrome-devtools-mcp` | TS | CDP 直连，性能追踪、网络面板 | 仅 Chromium。**对 L1 层的抓包发现很有用** |
| **BrowserTools MCP** | `AgentDeskAI/browser-tools-mcp` | TS | 从**用户真实 Chrome 会话**流式输出 console/network/screenshot/HAR，凭证在浏览器侧脱敏 | **企业内网关键**：Chrome 136 后禁止对默认 profile 远程调试，而内网 SSO 登录态都在默认 profile 里。此类"桥接已登录浏览器"方案是绕开重复登录的正解 |
| **network-capture-mcp** | `sfgarza/network-capture-mcp` | TS | 内置轻量代理 + DB，捕获并可查询流量 | **L1 层的直接积木**：用它把老系统的 Form POST 全录下来 |

### 2.2 类别 B：Agent 框架（有决策循环）

| 项目 | 仓库 | 语言 | 感知方式 | 控制权归属 | 适配场景 | 许可 |
|---|---|---|---|---|---|---|
| **browser-use** | `browser-use/browser-use` | Python | DOM 抽取 + 元素索引编号 | **Agent 拿目标自主规划** | 生态最大、示例最多、Python 栈友好 | MIT |
| **Stagehand** | `browserbase/stagehand` | TS | DOM + `act/extract/observe` 三原语 | **你写确定性代码，只在需要处调 AI** | 重复流程，**缓存后成本趋近于零** | MIT |
| **Skyvern** | `Skyvern-AI/skyvern` | Python | **计算机视觉优先** | 任务级，描述目标即可 | 表单密集、登录墙后的老旧门户；内置 2FA/CAPTCHA 处理 | ⚠️ **AGPL，商用需评估** |
| **Midscene.js** ⭐ | `web-infra-dev/midscene` | TS | **纯视觉 grounding**（仅凭截图） | SDK / YAML / Chrome 插件 | **正是为"DOM 不可靠"设计**：无语义 div、canvas、跨域 iframe、原生 App 全覆盖 | MIT |
| **UI-TARS / Agent-TARS** | `bytedance/UI-TARS`,`UI-TARS-desktop` | Py/TS | 端到端 GUI Agent 模型 | 模型即 Agent | 提供可私有化部署的 grounding 模型本体 | Apache-2.0 |

**Midscene 的官方立场值得引用**（它直接命中你的痛点）：

> 大多数 UI 自动化——包括读取 DOM 或 Accessibility Tree 的 AI 工具——都依赖页面结构。而这个结构是脆弱且不完整的：重构一次选择器就断，没有语义标记的元素（纯图标按钮、自定义控件、`<canvas>`）对它完全不可见，原生 App 和跨域 iframe 更是够不着，而且它无法判断东西"看起来对不对"。

同时也要客观：Midscene 官方也承认，**对于语义规范的普通表单，DOM 方案更快更便宜**。所以是"分层"，不是"二选一"。

### 2.3 类别 C：视觉 Grounding 模型（AI Page 的"眼睛"）

| 模型 | 来源 | 私有化 | 说明 |
|---|---|---|---|
| **UI-TARS-2 / 1.5-7B** | 字节，开源 | ✅ vLLM 可部署 | GUI 专用预训练。基准显示 GUI 元素定位准确率约 **78%**，而通用多模态大模型（GPT-4o、Qwen2.5-VL 类）在同类定位任务上**普遍低于 8%**——这个差距说明：**通用 VL 模型不能直接当 grounding 用，必须上 GUI 专用模型**。7B 量级，单卡可跑 |
| **Qwen3-VL 系列** | 阿里，开源 | ✅ | Midscene 官方推荐模型之一，中文场景友好 |
| **GLM-4.6V / GLM-5V** | 智谱 | ✅/API | 智谱 CogViT 编码器，可自主浏览网页、解析图表 |
| **GUI-Owl-1.5-32B**（Mobile-Agent-v3.5） | 阿里 | ✅ | 多平台 GUI 模型，grounding 基准 SOTA |
| **DeepSeek 多模态（视觉原语）** | DeepSeek | ✅ 已开源 | 2026-05-30 发布，V4-Flash（284B 总参 / 13B 激活 MoE）为主干 + 自研 ViT，任意分辨率。**核心创新是把点坐标和 bbox 变成推理的基本单位，穿插在思维链里**——这恰好是 GUI 定位需要的能力。视觉 token 压缩极致（756×756 图最终仅 81 个视觉 KV 条目，整体压缩比约 7056 倍），**成本优势巨大**。但注意：截至 2026 年年中，官方**纯文本 API 尚未开放视觉通道**，识图模式先在 Web/App 端全量，视觉 API 官方称"会跟 V4 价格对齐"后续开放 |
| **OmniParser** | 微软 | ✅ | 截图 → 结构化元素列表，可作为通用 VL 模型的前置解析器 |

> **选型建议**：DSH 主脑用 DeepSeek V4（文本推理 + 工具调用），grounding 副脑先用 **UI-TARS-1.5-7B 或 Qwen3-VL 私有化部署**，把接口抽象成 `IGroundingProvider`。等 DeepSeek 视觉 API 正式开放且验证过 ScreenSpot-Pro 类基准后，再无缝切换到全 DeepSeek 栈（成本上 DeepSeek 的视觉 token 压缩方案有压倒性优势，值得预留切换口）。

### 2.4 类别 D：API 侧 / MCP 薄层

| 项目 / 方案 | 用途 |
|---|---|
| `tadata-org/fastapi_mcp`、`open-api-mcp` | OpenAPI/Swagger → MCP 工具自动生成 |
| Apache APISIX / Higress / Kong 的 MCP 插件 | **网关层零代码把存量 REST API 转成 MCP 工具**，统一鉴权、限流、审计 |
| `mitmproxy` + 自研 | HAR → 接口画像 → OpenAPI 草稿（L1 层核心） |
| MCP Gateway（Obot 等） | 多 MCP Server 聚合、权限治理、审计留痕 |

---

## 3. 五种定位范式横向对比

| 范式 | 代表 | Vue 无语义 div | Token 成本 | 延迟 | 确定性 | 维护成本 |
|---|---|---|---|---|---|---|
| CSS/XPath 选择器 | 原生 Playwright | ❌ 哈希 class 即崩 | 0 | 极低 | 高 | 极高（每次重构都断） |
| **Accessibility Tree + ref** | Playwright MCP | ⚠️ 取决于 aria 补全度 | 中 | 低 | 高 | 低 |
| **语义 DOM 压缩 + 编号(SoM)** | browser-use / Midscene DOM grounding | ✅ 较好 | 中 | 低 | 中高 | 低 |
| **纯视觉 grounding** | Midscene / UI-TARS / Skyvern | ✅ **最强** | 高 | 高 | 中 | 极低 |
| **录制-回放 / 技能缓存** | Stagehand cache / Skyvern workflow | ✅（首跑靠上面几种） | ≈0 | 极低 | **极高** | 中（需自愈） |

**结论：生产系统必须是"探索期用 3/4 范式，稳定期落到 5 范式"的组合。**

---

## 4. 推荐架构：分层降级 + 技能固化

### 4.1 总体架构图

```
┌──────────────────────────────────────────────────────────────┐
│                   DSH Orchestrator (DeepSeek V4)              │
│        任务理解 → 计划分解 → 通道选择 → 执行监督 → 结果校验        │
└───────────────┬──────────────────────────────────────────────┘
                │
        ┌───────▼────────┐
        │ Skill Registry │  ← 技能库：一个业务动作 = 一个技能
        │  (技能路由/缓存) │     记录该技能可用的最高级通道
        └───────┬────────┘
                │  按 L0→L1→L2→L3→L4 顺序尝试，命中即停
   ┌────────────┼────────────┬─────────────┬────────────┐
   ▼            ▼            ▼             ▼            ▼
┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐
│  L0  │  │    L1    │  │    L2    │  │    L3    │  │   L4   │
│真实API│  │私有接口重放│  │结构化UI  │  │视觉GUI   │  │ 人工   │
│MCP薄层│  │HAR→MCP   │  │Playwright│  │Midscene  │  │ 接管   │
│      │  │          │  │   MCP    │  │/UI-TARS  │  │        │
└──────┘  └──────────┘  └──────────┘  └──────────┘  └────────┘
   │            │            │             │
   └────────────┴─────┬──────┴─────────────┘
                      ▼
        ┌──────────────────────────────┐
        │  统一执行沙箱 / 浏览器池        │
        │  会话管理 · SSO 复用 · 录屏     │
        └──────────────┬───────────────┘
                       ▼
        ┌──────────────────────────────┐
        │  Governance 治理层            │
        │  审计日志 · 权限 · 写操作二次确认 │
        └──────────────────────────────┘
```

### 4.2 各层职责定义

#### L0 — 真实 API（MCP 薄层）
- **适用**：新系统、有 Swagger/OpenAPI 的系统
- **实现**：网关插件（APISIX/Higress）零代码转换，或 `fastapi_mcp` 类工具生成
- **原则**：**薄层不做业务编排**。一个 API = 一个 tool，业务组合交给 Orchestrator。厚封装会让工具数量爆炸且难维护
- **工具描述要求**：`description` 必须写清楚**什么时候用**而不是**它是什么**，这是 LLM 选对工具的关键

#### L1 — 私有接口重放 ⭐ 最高性价比，重点投入
这是解决"C# MVC / JSP 没有 API"的**真正答案**。

**流程**：
```
1. 人工在浏览器中完整操作一遍业务流程（录制模式）
2. 代理 / CDP 捕获全部 HTTP 请求 → HAR
3. 差分分析：剔除静态资源、埋点、心跳，保留状态变更请求
4. 参数化：识别请求中的变量（单号、日期、用户ID）→ 提取为 tool 参数
5. 生成 OpenAPI 草稿 → 人工/LLM 审核确认 → 注册为 MCP 工具
6. 回放验证：用不同参数跑通，校验响应
```

**老系统的特殊处理**：

| 技术栈 | 挑战 | 对策 |
|---|---|---|
| ASP.NET WebForms | `__VIEWSTATE` / `__EVENTVALIDATION` 大字段、服务端状态 | 先 GET 页面提取隐藏字段 → 带上再 POST；封装成"两步式 tool" |
| ASP.NET MVC | AntiForgeryToken | 同上，先取 token |
| JSP / Struts | `.do` / `.action`，Session 强耦合 | 维持长会话 Cookie Jar；一个 tool 内部完成"取页面→提交" |
| 老式框架 | 响应是 HTML 而非 JSON | tool 内置 HTML→结构化 解析器（cheerio/lxml + 少量 LLM 兜底抽取） |

**这一层的收益**：确定性 100%、延迟毫秒级、零 LLM token、可并发、可审计。**能进 L1 的动作绝不要放到 L2/L3。**

> ⚠️ **合规提醒**：内网系统私有接口重放，需要提前与系统 Owner / 安全部门书面确认授权，并纳入变更管理。这不是技术问题而是流程问题，必须在项目启动阶段解决，否则后期会被安全一票否决。

#### L2 — 结构化 UI 操作（Playwright MCP 范式）
- 快照 → 带 `ref` 的 AX 树 → LLM 选 ref → 执行 → 新快照
- **前置增强**（见 §5）：注入 AX Polyfill 脚本，把 Vue 的裸 div 补上 `role`/`name`，让这一层的可用率从 30% 拉到 80%+
- 大页面务必用**增量快照**或 CLI 落盘模式，否则 token 会失控

#### L3 — 视觉 Grounding
- 截图 → VL 模型输出坐标/bbox → 点击
- 专治：canvas 图表、ECharts 交互、无语义图标按钮、跨域 iframe 嵌套的老系统页面、Flash/ActiveX 替代品
- **必须配 GUI 专用模型**，通用 VL 模型定位准确率不可用

#### L4 — 人工接管
- Agent 卡住 → 推送任务卡片给操作员 → 人接管完成 → **系统自动录制这一段并回灌到 L1/L2 技能库**
- 这是让系统随时间自我完善的闭环，不是"失败兜底"而是"数据采集"

### 4.3 技能缓存机制（核心设计）

```
Skill = {
  id, name, 业务描述,
  target_system, 
  channel: L0|L1|L2|L3,          // 当前可用的最优通道
  executable: {                   // 确定性执行体
     L1: { method, url, headers, body_template, param_schema },
     L2: { steps:[{action, selector_bundle, fallback_text_anchor}] },
     L3: { steps:[{action, nl_instruction, cached_bbox}] }
  },
  preconditions, postcondition_assertions,   // 执行前置/后置校验
  success_rate, last_success_at, version,
  self_heal_policy
}
```

**运行逻辑**：
1. 命中技能 → 走 `executable` 快通道（无 LLM 参与）
2. 快通道失败 → 降级到下一层 → 成功后**自动更新技能**（自愈）
3. 连续失败 N 次 → 标记 `degraded`，告警 + 转 L4
4. 无匹配技能 → 走完整 LLM 探索流程 → 成功后**固化为新技能**

这个机制决定了成本模型：探索一次贵，之后近乎免费。

---

## 5. 专项攻坚：Vue `div`+GUID 点击问题的 8 个工程手段

按推荐优先级排列。

### 手段 1 ⭐⭐⭐ — 运行时可访问性注入（AX Polyfill）
**思路**：在页面加载后注入一段脚本，遍历 DOM，给"看起来是交互元素"的裸 div 补上 `role` 和 `aria-label`，让 Accessibility Tree 立刻可用。

**识别启发式**：
- 有 `@click` 绑定（Vue 会留下 `__vueParentComponent` / 事件监听器，可用 `getEventListeners` 或 `__vue__` 探测）
- `cursor: pointer` 计算样式
- 常见组件库 class 前缀：`el-button`、`ant-btn`、`ivu-btn`、`arco-btn`（**组件库前缀通常不哈希，是稳定锚点**）
- `tabindex` 存在
- 内部只有文本或 `<i class="icon-*">`

```js
// inject-ax-polyfill.js  —— 通过 Playwright addInitScript 注入
(function () {
  const CLICKABLE_HINT = /(^|\s)(el-button|ant-btn|ivu-btn|arco-btn|van-button|btn|button)(\s|$|-)/;
  function looksClickable(el) {
    if (el.hasAttribute('role')) return false;
    const cs = getComputedStyle(el);
    if (cs.cursor === 'pointer') return true;
    if (CLICKABLE_HINT.test(el.className || '')) return true;
    if (el.hasAttribute('tabindex')) return true;
    return false;
  }
  function label(el) {
    const t = (el.innerText || '').trim().slice(0, 40);
    if (t) return t;
    const i = el.querySelector('i[class*="icon"],svg');
    if (i) return (i.className.baseVal || i.className || '').match(/icon-([\w-]+)/)?.[1] || 'icon';
    return el.getAttribute('title') || el.getAttribute('placeholder') || '';
  }
  function enhance(root = document) {
    root.querySelectorAll('div,span,li,td,a').forEach(el => {
      if (!looksClickable(el)) return;
      el.setAttribute('role', 'button');
      const l = label(el);
      if (l) el.setAttribute('aria-label', l);
      el.setAttribute('data-dsh-id', el.getAttribute('data-dsh-id') || crypto.randomUUID().slice(0, 8));
    });
  }
  enhance();
  new MutationObserver(ms => ms.forEach(m =>
    m.addedNodes.forEach(n => n.nodeType === 1 && enhance(n))
  )).observe(document.body, { childList: true, subtree: true });
})();
```

**效果**：Playwright MCP 的快照从一堆 `generic` 变成 `button "提交审批" [ref=e42]`。这是**投入 1 天、收益最大**的一件事。

### 手段 2 ⭐⭐⭐ — 文本锚点 + 向上寻找可点击祖先
Vue 页面里文字是稳定的（业务文案不会随构建变化），结构不稳定。所以：**先定位文本节点，再向上冒泡找到真正绑定了 click 的祖先。**

```js
function clickByText(text, { exact = false, nth = 0 } = {}) {
  const xp = exact
    ? `//*[normalize-space(text())="${text}"]`
    : `//*[contains(normalize-space(.),"${text}")][not(.//*[contains(normalize-space(.),"${text}")])]`;
  const it = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const el = it.snapshotItem(nth);
  if (!el) throw new Error('text not found: ' + text);
  let cur = el;
  for (let i = 0; i < 8 && cur; i++) {
    if (getComputedStyle(cur).cursor === 'pointer' ||
        ['BUTTON','A'].includes(cur.tagName) ||
        cur.getAttribute('role') === 'button') {
      cur.scrollIntoView({ block: 'center' });
      return cur;
    }
    cur = cur.parentElement;
  }
  return el;
}
```

### 手段 3 ⭐⭐ — 直接事件派发，绕过选择器
拿到元素后，不走 Playwright 的坐标点击（会被遮罩、动画、fixed 定位干扰），直接派发事件：

```js
function robustClick(el) {
  el.scrollIntoView({ block: 'center' });
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', opts));
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new PointerEvent('pointerup', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
}
```

对 `<input>` 输入还需触发 Vue 的响应式：
```js
function setInputValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
```

### 手段 4 ⭐⭐ — 语义 DOM 压缩 + 数字标注（Set-of-Marks）
把整页 DOM 压成 LLM 友好的紧凑列表，只保留可交互元素，每个给一个序号：

```
[1] button "新建工单"
[2] input "工单标题" placeholder="请输入"
[3] select "优先级" value="中"
[4] row 3 | 单号 WO-20260817-001 | 状态 待审批 | [5] link "查看" [6] button "审批"
[7] button "下一页"
```
LLM 只需回 `click(6)`。这比让 LLM 生成选择器可靠一个数量级，也是 browser-use 的核心机制。

**压缩规则**：剔除不可见元素、剔除纯布局 div、合并同质表格行、截断超长文本、保留 DOM 层级缩进。目标：**单页快照 < 3000 token**。

### 手段 5 ⭐⭐ — 前端侧一次性改造（如果能推动）
在 Vue 项目里加一个全局指令或 babel 插件，构建期给所有交互元素自动注入 `data-testid`：

```js
// 全局指令方案
app.directive('tid', { mounted(el, binding) { el.setAttribute('data-testid', binding.value); } });
// 用法：<div v-tid="'submit-approval'" @click="submit">提交</div>
```

或直接用编译期插件（如 `unplugin-vue-testid` 思路）按组件名+行号自动生成稳定 testid。

**这是最优解**，如果内部前端团队可协作，务必推动。成本一周，收益永久。

### 手段 6 ⭐ — 元素指纹 + 多特征打分自愈
不存单一选择器，存一个"指纹包"：

```json
{
  "text": "提交审批",
  "role": "button",
  "tag": "div",
  "stable_class_tokens": ["el-button", "el-button--primary"],
  "ancestor_text_path": ["工单详情", "操作区"],
  "sibling_index": 2,
  "bbox_ratio": [0.72, 0.88, 0.08, 0.04],
  "icon_hint": "check"
}
```
执行时按权重打分匹配，任一特征失效不影响整体，命中后**用新 DOM 状态更新指纹**（自愈）。

### 手段 7 — 虚拟滚动处理
表格找不到目标行时，不要直接失败。策略：
1. 优先用搜索/筛选框缩小范围（**永远优先于滚动**）
2. 不行则分段滚动 + 每段快照 + 累计去重
3. 设置最大滚动轮次，超限报"目标不存在"

### 手段 8 — 视觉兜底
以上全失败 → 截图 → VL 模型输出 bbox → 坐标点击。**这是兜底不是主路径**，因为慢、贵、且分辨率/缩放变化会漂移。

---

## 6. 企业内网特殊考量

| 议题 | 方案 |
|---|---|
| **SSO / AD 域认证** | 优先用 **Bridge Mode / 浏览器桥接**（Midscene Bridge Mode、BrowserTools MCP 思路），复用操作员已登录的真实 Chrome 会话，避免在自动化里存明文凭证。注意 Chrome 136+ 禁止对默认 profile 远程调试，须用扩展桥接方案 |
| **凭证管理** | 必须用凭证保管库（Vault/KMS），Agent 只拿短期票据。**严禁把账号密码写进 Prompt** |
| **网络隔离** | 全栈私有化：模型（vLLM/SGLang）+ MCP Server + 浏览器池 全部部署在内网。DeepSeek 可用官方 API 或私有化权重（V4 系列已 MIT 开源） |
| **审计与留痕** | 每一次工具调用、每一次点击、每一帧截图都要落库；写操作必须记录 who/what/when/before/after。这是内网合规的硬门槛 |
| **权限最小化** | Agent 用**专用低权账号**，不复用人的账号。按系统/按动作做白名单 |
| **写操作管控** | 分级：查询类自动执行；变更类需二次确认；高风险（删除、审批、付款）强制人工确认 + 双人复核 |
| **数据出域** | 若用外部模型 API，页面截图/DOM 可能含敏感数据。必须做**脱敏管道**（手机号、身份证、金额掩码）或强制私有化 |
| **浏览器池** | 用容器化 Chrome + 会话隔离；不要多任务共用一个浏览器实例，避免 Cookie 串号 |
| **变更适配** | 内网系统升级会批量打断技能。需要**每日巡检任务**跑一遍核心技能，失败即告警 |

---

## 7. 落地路线图

### Phase 0 — 基线与选型验证（2 周）
- [ ] 挑选 **3 个代表性系统**：1 个 Vue 新系统、1 个 ASP.NET MVC、1 个 JSP
- [ ] 每个系统挑 5 个高频业务动作，共 15 个作为 **黄金测试集**
- [ ] 分别用 Playwright MCP（裸跑）、Playwright MCP + AX Polyfill、Midscene 视觉三种方案跑通率对比
- [ ] 产出：**成功率 / 平均耗时 / 单次 token 成本** 三维基线表
- [ ] grounding 模型选型：UI-TARS-1.5-7B vs Qwen3-VL 在**你自己的 15 个动作截图**上做定位准确率测试（不要信公开榜单）
- [ ] **同步启动**：与安全/合规部门确认接口重放的授权流程

### Phase 1 — MCP 线（4 周）
- [ ] L0：网关侧 OpenAPI → MCP 自动转换，接入已有 API 系统
- [ ] L1：抓包录制器 + HAR 分析器 + 参数化引擎 + OpenAPI 生成器
- [ ] L1：老系统适配器（ViewState / AntiForgery / Struts Session / HTML 解析）
- [ ] MCP Gateway：统一鉴权、限流、审计、工具发现
- [ ] 交付：**15 个动作中能进 L0/L1 的比例**（目标 ≥ 50%）

### Phase 2 — AI Page 线（6 周，与 Phase 1 并行）
- [ ] 基于 `microsoft/playwright-mcp` fork 或封装，加入 **AX Polyfill 注入**
- [ ] 实现语义 DOM 压缩器（SoM 编号）
- [ ] 实现 `robustClick` / `clickByText` / `setInputValue` 工具集
- [ ] 接入 Midscene 作为 L3 视觉通道（`IGroundingProvider` 抽象）
- [ ] 实现降级链路 + 重试 + 断言校验
- [ ] 浏览器桥接模式（复用已登录会话）

### Phase 3 — 技能系统与自愈（4 周）
- [ ] Skill Registry 数据模型 + 存储
- [ ] 录制器：把成功轨迹固化为技能
- [ ] 快通道执行器 + 失败降级 + 自愈更新
- [ ] 元素指纹匹配引擎
- [ ] 巡检任务 + 告警

### Phase 4 — 治理与生产化（4 周）
- [ ] 审计日志、录屏回放、写操作审批流
- [ ] 人工接管（HITL）工作台
- [ ] 可观测：成功率大盘、成本大盘、技能健康度
- [ ] 灰度发布机制

**总计约 18–20 周（4.5 个月），两条线并行。**

---

## 8. 关键接口定义（供实施参考）

### 8.1 统一执行接口

```typescript
type Channel = 'L0_API' | 'L1_REPLAY' | 'L2_DOM' | 'L3_VISION' | 'L4_HUMAN';

interface ActionRequest {
  skillId?: string;              // 有技能则走快通道
  intent: string;                // 自然语言意图（无技能时用）
  targetSystem: string;
  params: Record<string, any>;
  allowChannels: Channel[];      // 允许的通道，用于策略控制
  riskLevel: 'read' | 'write' | 'critical';
}

interface ActionResult {
  ok: boolean;
  channelUsed: Channel;
  data?: any;
  evidence: {                    // 审计证据
    screenshots?: string[];
    httpTrace?: string[];
    domSnapshotRef?: string;
  };
  cost: { tokens: number; latencyMs: number };
  skillUpdated?: boolean;        // 是否触发了自愈
}
```

### 8.2 Grounding Provider 抽象（便于切换模型）

```typescript
interface IGroundingProvider {
  name: string;                  // 'ui-tars' | 'qwen-vl' | 'deepseek-vl'
  locate(screenshot: Buffer, instruction: string): Promise<{
    bbox: [number, number, number, number];
    point: [number, number];
    confidence: number;
  }>;
}
```

### 8.3 L1 接口重放工具规格

```yaml
tool:
  name: "wo_submit_approval"
  description: "提交工单审批。当用户要求把某个工单送审、提交审批、走流程时使用。"
  system: "legacy-wo-jsp"
  channel: L1_REPLAY
  preflight:                      # 老系统必需：先取页面拿隐藏字段
    method: GET
    url: "/wo/detail.do?id={{workOrderId}}"
    extract:
      viewstate: "input[name=__VIEWSTATE]@value"
      token: "input[name=__RequestVerificationToken]@value"
  request:
    method: POST
    url: "/wo/submitApproval.do"
    contentType: "application/x-www-form-urlencoded"
    body:
      id: "{{workOrderId}}"
      comment: "{{comment}}"
      __VIEWSTATE: "{{preflight.viewstate}}"
      __RequestVerificationToken: "{{preflight.token}}"
  params_schema:
    workOrderId: { type: string, required: true }
    comment:     { type: string, required: false, default: "" }
  assert:
    - "status == 200"
    - "body contains '提交成功' or json.code == 0"
```

---

## 9. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| **过度依赖 AI Page，成功率上不去** | 项目失败 | 强制 L0/L1 优先；把"L0+L1 覆盖率"作为核心 KPI 而不是"Agent 成功率" |
| 内网系统升级导致技能批量失效 | 运维负担 | 每日巡检 + 自愈机制 + 与各系统 Owner 建立变更通知渠道 |
| 接口重放被安全部门认定为违规 | 阻塞 | **Phase 0 就要拿到书面授权**，不要等做完再谈 |
| 视觉模型定位不准 | L3 不可用 | 用自己业务截图做选型验证，不信公开榜单；准备 L4 兜底 |
| Token 成本失控 | 预算超支 | 快照压缩 + 增量快照 + 技能缓存；设置单任务 token 上限熔断 |
| DeepSeek 视觉 API 时间表不确定 | 影响 L3 排期 | grounding 层做接口抽象，先用开源 VL 模型顶上，不阻塞主线 |
| 写操作误执行 | **业务事故** | 分级管控 + 二次确认 + 沙箱环境先验证 + 可回滚设计 |
| AGPL 许可污染 | 法务风险 | Skyvern 是 AGPL，若要用需法务评估；优先 MIT/Apache 的 Playwright MCP、Midscene、browser-use |

---

## 10. 给实施方（GPT / 编码助手）的任务清单

按可直接开工的粒度拆分：

### 任务组 A：浏览器执行层
- **A1**：搭建 Playwright MCP 服务，验证 `browser_snapshot` / `browser_click{ref}` 在目标 Vue 系统上的表现，记录失败案例
- **A2**：实现 `inject-ax-polyfill.js`（见 §5 手段 1），通过 `context.addInitScript()` 注入，对比 A1 的快照质量改善
- **A3**：实现语义 DOM 压缩器：输入 DOM，输出 SoM 编号列表，单页 < 3000 token
- **A4**：实现工具集 `clickByText` / `robustClick` / `setInputValue` / `scrollToFind`，暴露为 MCP tools
- **A5**：实现浏览器桥接模式（Chrome 扩展 + WebSocket），复用已登录会话

### 任务组 B：视觉通道
- **B1**：私有化部署 UI-TARS-1.5-7B（vLLM），暴露 OpenAI 兼容接口
- **B2**：实现 `IGroundingProvider`，适配 UI-TARS / Qwen-VL / 预留 DeepSeek-VL
- **B3**：集成 Midscene.js 作为 L3 执行器，或自研轻量版（截图 → locate → 坐标点击）
- **B4**：坐标校准：处理 devicePixelRatio、页面缩放、滚动偏移

### 任务组 C：接口重放（L1）
- **C1**：抓包录制器（基于 CDP Network domain 或 mitmproxy），输出 HAR
- **C2**：HAR 分析器：过滤静态资源/埋点，识别状态变更请求
- **C3**：参数化引擎：多次录制做差分，自动识别变量位
- **C4**：老系统适配器：ViewState / AntiForgeryToken / Struts Session / Cookie Jar
- **C5**：HTML 响应结构化解析器
- **C6**：YAML 工具规格 → 可执行 MCP tool 的运行时

### 任务组 D：编排与技能
- **D1**：Skill Registry（数据模型 + CRUD + 版本管理）
- **D2**：通道路由器（L0→L4 降级链）
- **D3**：轨迹录制 → 技能固化
- **D4**：元素指纹匹配引擎 + 自愈更新
- **D5**：DeepSeek Orchestrator：任务分解、工具选择、结果校验、失败重规划
- **D6**：后置断言引擎（每个动作执行后校验业务状态，而不只看 HTTP 200）

### 任务组 E：治理
- **E1**：审计日志（结构化 + 录屏 + 截图证据链）
- **E2**：写操作分级 + 二次确认工作流
- **E3**：HITL 接管工作台
- **E4**：可观测大盘：成功率 / 成本 / 技能健康度
- **E5**：每日巡检任务

---

## 附录 A：调研信息来源

- Playwright MCP 官方文档（Accessibility Snapshot / ref 机制）— playwright.dev/mcp
- `microsoft/playwright-mcp`、`@playwright/cli`（2026 年初发布，token 省约 4x）
- `web-infra-dev/midscene`（MIT，纯视觉 grounding，支持 Web/Android/iOS/Desktop）
- `bytedance/UI-TARS`、`UI-TARS-desktop`（UI-TARS-2 于 2025-09 发布）
- `browser-use/browser-use`、`browserbase/stagehand`、`Skyvern-AI/skyvern`
- `AgentDeskAI/browser-tools-mcp`（真实 Chrome 会话桥接）
- `sfgarza/network-capture-mcp`（流量捕获 MCP）
- GUI-Robust 数据集论文（arXiv 2506.14477）— GUI 专用模型 vs 通用 MLLM 定位准确率对比
- UI-TARS 论文（arXiv 2501.12326）— ScreenSpot / ScreenSpot-Pro 基准
- Mobile-Agent-v3.5 / GUI-Owl-1.5 论文（arXiv 2602.16855）
- DeepSeek《Thinking with Visual Primitives》技术报告（2026-05-30 开源）
- 2026 年开源浏览器 Agent 横评（真实登录/表单任务最高 64.4%）

## 附录 B：术语

| 术语 | 说明 |
|---|---|
| AX Tree | Accessibility Tree，浏览器为无障碍技术生成的语义树 |
| SoM | Set-of-Marks，给页面元素编号后让模型按编号操作 |
| Grounding | 把自然语言描述映射到屏幕上具体元素/坐标 |
| Bridge Mode | 桥接用户已登录的真实浏览器，而非启动全新自动化浏览器 |
| HITL | Human-in-the-loop，人工介入环节 |
| 技能固化 | 把 LLM 探索出的成功路径转换为确定性可重放脚本 |

---

**文档结束**
