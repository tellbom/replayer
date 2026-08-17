# DSH 内网技能自动化平台 · 技术方案 v2

> 版本：v2.0 ｜ 日期：2026-08-17
> 前置约束（v2 相对 v1 的重大变更）：
> - ❌ 无法获取各系统 API 令牌，业务部门不配合做 MCP 适配
> - ❌ 内网 DeepSeek 不支持图像多模态，无视觉 grounding 能力
> - ✅ 用户本人在浏览器中已通过 SSO 登录各内网系统
>
> 结论：**放弃"系统对接"路线，转向"代理用户身份 + 用户自助技能平台"路线。**

---

## 0. 定位转变

### v1 的思路（已废弃）
```
DSH 平台 →（申请 API 权限/令牌）→ 各业务系统
           ↑ 卡死：部门不配合，没有令牌
```

### v2 的思路
```
DSH 扩展（跑在用户浏览器里）→ 借用用户已有登录态 → 各业务系统
           ↑ 对方部门零工作量，因为这就是用户自己的操作
```

**一句话概括**：不做系统集成，做"给用户装一个会自己点页面的助手"。

这个转变带来的连锁效果：

| 维度 | v1 | v2 |
|---|---|---|
| 对方部门工作量 | 需开 API、发令牌、配合联调 | **零** |
| 权限模型 | 需申请服务账号，容易被质疑越权 | 天然等于用户自身权限，无越权空间 |
| 令牌管理 | 需要凭证保管库、轮换机制 | **不存在**（不持有凭证） |
| 服务端视角 | 一个陌生的服务账号在调 API | 该用户在正常使用系统 |
| 主要风险 | 权限审批周期 | 审计归属、合规定性、变更失联 |

---

## 1. 身份与凭证模型（关键设计）

这是整个方案的地基，必须先定清楚。三种模式，**强烈建议只用模式 A**。

### 模式 A ⭐ 推荐：页面内同源执行（不提取任何凭证）

在用户已登录的页面上下文里执行请求，Cookie / Authorization 由浏览器自动附加。

```js
// content script 注入到页面 MAIN world 执行
async function callInPage(path, payload) {
  // CSRF / ViewState 从当前页面提取
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content
            || document.querySelector('input[name="__RequestVerificationToken"]')?.value;

  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',          // 同源，Cookie 自动带
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(csrf ? { 'X-CSRF-TOKEN': csrf } : {})
    },
    body: new URLSearchParams(payload)
  });
  return { status: res.status, text: await res.text() };
}
```

**优点**：
- 零凭证外泄。DSH 服务端从头到尾不接触任何 token
- 不需要处理 token 过期/刷新——浏览器和 SSO 会话自己管
- 对 Cookie 会话（JSP/ASP.NET）和 Bearer 会话（Vue SPA）通吃
- 安全评审最容易通过：**你没有复制任何凭证**

**限制**：用户必须在线且浏览器开着。

### 模式 B ⚠️ 谨慎：令牌提取 + 扩展内调用

拦截 `webRequest` 或读 `localStorage`，把 token 存在扩展内存里，由扩展的 background 发请求。

```js
// manifest v3 · background service worker
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const auth = details.requestHeaders.find(h => h.name.toLowerCase() === 'authorization');
    if (auth) tokenStore.set(new URL(details.url).origin, {
      value: auth.value, capturedAt: Date.now()
    });
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);
```

**只在这一种情况下才需要**：请求必须从非页面上下文发起（比如跨系统串联，A 系统页面上调 B 系统接口，被同源策略挡住）。

**硬性约束**：
- 令牌**只准留在扩展内存**，绝不落盘、绝不上传 DSH 服务端
- 设置 TTL（建议 ≤ 30 分钟），过期即丢弃并重新捕获
- 浏览器关闭即清空
- 必须在安全评审中显式报备这一行为

### 模式 C ❌ 不推荐：令牌上传服务端，后台定时执行

把 token 传回 DSH 服务端，服务端脱离浏览器发请求。

**为什么不推荐**：
- 这是在制造凭证副本，等同于变相的凭证窃取，安全部门大概率一票否决
- token 过期后无法自动续期（SSO 刷新逻辑在浏览器里），可靠性差
- 一旦服务端被攻破，等于泄漏所有用户的所有系统凭证

**如果确实需要用户不在线时执行**（定时任务、批量处理），**老实去申请服务账号**。这时候你手里已经有跑通的技能和实际业务价值，去谈判的筹码完全不同了。

### 决策树

```
需要执行一个动作
   │
   ├─ 用户在线且页面可打开？
   │     ├─ 是 → 【模式 A】页面内同源执行     ← 覆盖 95% 场景
   │     └─ 否 → 需要定时/离线执行？
   │              └─ 是 → 走正式服务账号申请（拿业务价值去谈）
   │
   └─ 跨系统调用被同源策略挡住？
         └─ 是 → 【模式 B】扩展内令牌，内存态，TTL 限制
```

---

## 2. 关于"服务端看到的都是用户操作"

**是的，完全是。** 服务端无法从请求本身区分是人点的还是 DSH 点的——Cookie、User-Agent、Referer、请求体格式全都一致。

这带来两面性：

**好的一面**：
- 权限天然最小化，Agent 能做的恰好是用户本来就能做的，不存在提权路径
- 不触发任何风控（不是异常来源、不是异常账号）
- 业务系统的审批流、权限校验全部原样生效，无需重新实现

**必须补的一面**：业务系统日志里无法追溯"这是自动执行的"。所以：

1. **DSH 侧留完整链路**（这是硬要求）：
   ```json
   {
     "traceId": "...", "userId": "...", "skillId": "gatepass_submit",
     "trigger": "用户对话输入原文",
     "params": { "items": [...], "reason": "客户演示" },
     "confirmedAt": "2026-08-17T10:23:11+08:00",
     "requests": [{ "method": "POST", "url": "...", "status": 200 }],
     "screenshots": ["before.png", "after.png"],
     "result": { "ok": true, "bizId": "GP-20260817-0042" }
   }
   ```

2. **可选：加自定义请求头标记**
   ```
   X-DSH-Agent: skill/gatepass_submit@v3
   X-DSH-Trace: 7f3a9c2e
   ```
   大多数老系统会忽略未知 header，不影响功能，但如果对方系统愿意在日志里记录，双方对账就容易得多。**这一条可以作为跟业务部门的"低成本合作请求"**——比让他们建 MCP 服务容易接受一百倍。

3. **写操作强制用户确认**。用户点了确认，责任链就完整了：是用户授权的操作，DSH 只是执行工具。这一点在合规讨论中极其重要。

---

## 3. 通用 vs 固化：正确的分层

你的直觉是对的，但需要精确化。**不是"每个流程独立开发一套"，而是"一套引擎 + N 个技能配置"。**

```
┌─────────────────────────────────────────┐
│  技能层（每个流程独立，用户可自建）        │  ← 固化、配置化、无代码
│  出门条提交 / 报销录入 / 工单派发 / ...    │
├─────────────────────────────────────────┤
│  执行引擎（完全通用）                     │  ← 一次开发
│  动作原语 · 定位策略 · 断言 · 降级 · 自愈  │
├─────────────────────────────────────────┤
│  感知层（完全通用）                       │  ← 一次开发
│  DOM 压缩 · AX 增强 · 网络捕获 · 元素指纹  │
├─────────────────────────────────────────┤
│  浏览器扩展底座（完全通用）                │  ← 一次开发
└─────────────────────────────────────────┘
```

**LLM 在这个架构里只负责两件事**：
1. **意图 → 技能路由 + 参数抽取**（用户说"我明天要带笔记本出去" → 匹配到 `gatepass_submit` 技能，抽出参数）
2. **录制阶段的辅助理解**（帮用户命名步骤、识别哪些字段该参数化）

**执行阶段 LLM 完全不参与。** 这意味着：
- 零 token 成本
- 毫秒级延迟
- 100% 确定性，同样输入必然同样输出
- 可审计、可回归测试

这正好绕开了"内网 DeepSeek 无视觉"这个约束——**主路径本来就不需要视觉**。

---

## 4. 技能模型定义

技能是本平台的核心资产。数据模型：

```yaml
skill:
  id: "gatepass_submit"
  name: "提交物品出门申请"
  description: "当用户要带设备/物品出公司时，提交出门条申请单"
  owner: "张三"                    # 创建者
  visibility: private | team | org  # 可见范围
  version: 3
  system:
    name: "出门条系统"
    baseUrl: "http://gatepass.corp.local"
    techStack: "aspnet-mvc"        # 影响预处理策略

  # ── 触发 ──
  trigger:
    utterances:                     # 用于意图匹配的示例说法
      - "我要带笔记本出去"
      - "申请出门条"
      - "帮我提交物品出门"

  # ── 参数 ──
  params:
    - name: items
      type: array
      itemSchema: { name: string, qty: integer, sn: string? }
      required: true
      prompt: "要带哪些物品？"
    - name: reason
      type: string
      required: true
      prompt: "出门事由是什么？"
    - name: outDate
      type: date
      required: true
      default: "today"

  # ── 执行：双通道 ──
  execution:
    primary: network                # 优先走网络重放（快、稳）
    fallback: ui                    # 失败降级到 UI 操作

    network:
      steps:
        - id: preflight
          method: GET
          url: "/GatePass/Create"
          extract:
            token: "input[name=__RequestVerificationToken]@value"
            viewstate: "input[name=__VIEWSTATE]@value"
        - id: submit
          method: POST
          url: "/GatePass/Create"
          contentType: "application/x-www-form-urlencoded"
          body:
            __RequestVerificationToken: "{{preflight.token}}"
            __VIEWSTATE: "{{preflight.viewstate}}"
            Reason: "{{reason}}"
            OutDate: "{{outDate|date:yyyy-MM-dd}}"
            "Items[{{i}}].Name": "{{items[i].name}}"
            "Items[{{i}}].Qty": "{{items[i].qty}}"

    ui:
      steps:
        - action: navigate
          url: "/GatePass/Create"
        - action: fill
          target: { fingerprint: "fp_reason_input" }
          value: "{{reason}}"
        - action: forEach
          over: "{{items}}"
          do:
            - action: click
              target: { fingerprint: "fp_add_item_btn" }
            - action: fill
              target: { fingerprint: "fp_item_name", scope: "lastRow" }
              value: "{{item.name}}"
        - action: click
          target: { fingerprint: "fp_submit_btn" }
          confirm: true              # 写操作，需用户确认

  # ── 断言：判断成功的依据 ──
  assertions:
    - type: httpStatus
      expect: 200
    - type: textPresent
      expect: "提交成功"
    - type: extract
      name: bizId
      pattern: "申请单号[：:]\\s*([A-Z0-9-]+)"

  # ── 治理 ──
  governance:
    riskLevel: write                # read | write | critical
    requireConfirm: true
    maxPerDay: 20

  # ── 健康度 ──
  health:
    successRate: 0.98
    runCount: 412
    lastSuccessAt: "2026-08-16T14:22:00+08:00"
    status: healthy                 # healthy | degraded | broken
```

### 元素指纹（替代脆弱的选择器）

针对 Vue 的 hash class / GUID 问题，不存单一选择器，存多特征指纹，执行时打分匹配：

```json
{
  "id": "fp_submit_btn",
  "features": {
    "text": "提交申请",
    "role": "button",
    "tag": "div",
    "stableClassTokens": ["el-button", "el-button--primary"],
    "ancestorTexts": ["出门申请", "操作"],
    "siblingIndex": 1,
    "bboxRatio": [0.72, 0.88, 0.10, 0.04],
    "nearbyTexts": ["取消", "保存草稿"]
  },
  "weights": { "text": 0.4, "role": 0.15, "stableClassTokens": 0.2,
               "ancestorTexts": 0.15, "bboxRatio": 0.1 },
  "threshold": 0.65
}
```

匹配到唯一元素后，**用新的 DOM 状态回写指纹**（自愈）。任一特征失效不导致整体失败。

---

## 5. 技能录制器（平台的核心交互）

用户自助创建技能的方式：**做一遍给它看**。

### 录制流程

```
用户点"录制新技能"
   ↓
扩展进入录制模式（页面顶部显示红色录制条）
   ↓
用户正常操作一遍完整业务流程
   ↓
【双通道同时记录】
   通道1 · UI 动作流：每次 click/input/select
            → 记录元素指纹 + 动作类型 + 值
   通道2 · 网络请求流：每个 XHR / form submit
            → 记录 method/url/headers/body/response
   ↓
用户点"结束录制"
   ↓
【自动分析】
   - 剔除静态资源、埋点、心跳、轮询
   - 关联：哪个 UI 动作触发了哪个网络请求
   - 识别状态变更请求（非 GET，或 GET 但有副作用）
   - 候选参数识别：用户输入过的值 → 高概率是参数
   ↓
【参数化向导】（LLM 辅助）
   展示："检测到这些值可能需要每次不同，请确认："
   ┌────────────────────────────────────┐
   │ ☑ "戴尔笔记本"  → 参数 items[0].name │
   │ ☑ "客户演示"    → 参数 reason        │
   │ ☑ "2026-08-18"  → 参数 outDate       │
   │ ☐ "研发中心"    → 固定值（不参数化）  │
   └────────────────────────────────────┘
   ↓
【二次录制验证】（可选但强烈建议）
   用不同参数再跑一遍，验证参数化正确
   ↓
【断言配置】
   "怎么判断成功了？"
   → 用户从结果页选中"提交成功"文本 → 生成断言
   ↓
技能保存，进入技能库
```

### 关键设计点

**1. 双通道录制是必须的。** 只录 UI 动作 → 回放慢且脆；只录网络请求 → 无法处理纯前端交互（下拉选择、动态增行）。两个都录，执行时优先用网络通道，失败降级到 UI 通道。

**2. 参数识别的启发式**（不要全靠 LLM）：
- 用户手动输入过的值 → 高概率参数
- 日期格式的值 → 高概率参数
- 在多次录制中变化的值 → 确定是参数
- 下拉框选项 → 枚举型参数
- 隐藏字段、token、viewstate → 绝不参数化，运行时提取

**3. 老系统特殊处理**（录制器要内置识别）：

| 检测到 | 自动处理 |
|---|---|
| `__VIEWSTATE` / `__EVENTVALIDATION` | 生成 preflight GET 步骤先提取 |
| `__RequestVerificationToken` | 同上 |
| `.do` / `.action` 后缀 | 标记为 Struts，注意 Session 保持 |
| 响应是 HTML 而非 JSON | 生成 HTML 解析规则（用户选中要提取的内容） |
| 多步向导页面 | 记录页面跳转链，保持步骤顺序 |

---

## 6. 执行引擎

### 执行流程

```
用户输入 / 定时触发
   ↓
【意图路由】DeepSeek：匹配技能 + 抽取参数
   ↓
【参数补全】缺失参数 → 反问用户
   ↓
【预览确认】展示将要执行的操作 + 参数（写操作强制）
   ┌────────────────────────────────────┐
   │ 即将提交出门申请：                   │
   │  物品：戴尔笔记本 ×1、投影仪 ×1      │
   │  事由：客户演示                      │
   │  日期：2026-08-18                   │
   │        [确认执行]  [修改]  [取消]    │
   └────────────────────────────────────┘
   ↓
【执行】
   ├─ 尝试 network 通道
   │    成功 → 断言校验 → 完成
   │    失败 → 降级
   ├─ 尝试 ui 通道
   │    成功 → 断言校验 → 完成 + 更新指纹（自愈）
   │    失败 → 降级
   └─ 转人工接管
        → 弹出页面，用户手动完成
        → 【自动录制这一段】→ 回灌更新技能
   ↓
【留痕】完整链路落库
   ↓
【回报】"已提交，申请单号 GP-20260817-0042"
```

### 无视觉层的兜底策略

因为没有视觉 grounding，L3 层缺失，兜底逻辑必须加强：

1. **UI 通道的定位策略要多路并行**（按序尝试）：
   - 指纹打分匹配
   - 文本锚点 + 向上寻找可点击祖先
   - 组件库稳定 class 前缀（`el-`、`ant-`、`ivu-` 通常不哈希）
   - 相对定位（"'事由'标签右侧的输入框"）
   - `data-testid`（如果前端配合加了）

2. **AX Polyfill 注入**：给 Vue 裸 div 补 `role`/`aria-label`，提升可定位性（见附录 A）

3. **人工接管必须是一等公民**，不是失败提示。它是数据采集入口。

4. **预留视觉接口**：`IGroundingProvider` 抽象保留，将来若允许部署 UI-TARS-7B（单卡可跑，与 DeepSeek 主脑独立），一周内可补上。

---

## 7. 平台产品形态

这才是最终交付物：**一个让用户自己造技能的平台**。

### 7.1 用户角色

| 角色 | 能力 |
|---|---|
| **普通用户** | 用技能（对话/点击触发）、看执行历史 |
| **技能创建者** | 录制、编辑、测试、发布自己的技能 |
| **团队管理员** | 审核技能、设置可见范围、管控高风险技能 |
| **平台管理员** | 全局治理、审计、系统健康度 |

### 7.2 核心页面

```
1. 对话入口
   用户自然语言 → 意图路由 → 参数确认 → 执行
   支持"最近使用的技能"快捷卡片

2. 技能市场
   ├ 我的技能
   ├ 团队共享技能
   ├ 全公司技能（需审核发布）
   └ 按系统分类浏览
   每个技能显示：成功率、使用次数、健康状态、创建者

3. 技能录制器
   一键开始录制 → 引导式参数化 → 测试 → 发布

4. 技能编辑器
   ├ 步骤列表（可拖拽排序、增删改）
   ├ 参数配置
   ├ 断言配置
   ├ 版本历史 + 回滚
   └ 测试运行（沙箱/真实环境切换）

5. 执行历史
   每次执行的完整留痕、截图、请求记录、可重放

6. 治理后台
   技能健康度大盘、失败告警、审批队列、审计导出
```

### 7.3 编排：把多个技能串成工作流

单个技能 = 一个原子业务动作。多个技能可以编排：

```yaml
workflow:
  name: "新员工设备领用全流程"
  steps:
    - skill: asset_apply           # 资产系统：提交领用申请
      params: { assetType: "{{deviceType}}" }
      output: applyId
    - skill: gatepass_submit       # 出门条系统：提交出门申请
      params: { items: "{{steps[0].result.items}}" }
      condition: "{{needTakeOut}}"
    - skill: notify_manager        # OA：通知主管
      params: { refId: "{{steps[0].output.applyId}}" }
```

**这是跨系统打通的真正价值点**——业务部门各自为政的系统，在用户身份层面被串起来了，而任何一个部门都不需要配合。

### 7.4 版本与自愈

- 技能有版本号，每次编辑生成新版本，可回滚
- 每日巡检：用测试参数跑一遍高频技能，失败即告警 + 标记 `degraded`
- 自愈：UI 通道执行成功后自动更新元素指纹
- 系统改版导致大面积失败 → 通知创建者重新录制（引导式，只需重录失败的那几步）

---

## 8. 治理与合规

### 8.1 风险分级

| 级别 | 定义 | 管控 |
|---|---|---|
| **read** | 只查询，无状态变更 | 自动执行，无需确认 |
| **write** | 创建/修改业务数据 | **强制预览确认**，留痕 |
| **critical** | 审批、删除、付款、权限变更 | 强制确认 + 二次验证 + 管理员可见告警 |

风险级别由录制器**自动推断**（POST/PUT/DELETE → write；URL 含 approve/delete/pay → critical），创建者可上调不可下调。

### 8.2 必须落实的事项

- [ ] **合规定性前置**：在开发前就跟安全/合规/法务确认"程序以员工身份自动提交业务单据"的定性。这是项目最大的非技术风险
- [ ] **用户知情同意**：安装扩展时明确告知会记录操作、会代为执行
- [ ] **审计留痕不可篡改**：执行日志写入独立存储，创建者不可删改
- [ ] **敏感数据脱敏**：录制的请求体中若含身份证/手机号/金额，存储前脱敏
- [ ] **扩展分发**：走企业 IT 统一策略下发（Chrome Enterprise Policy），不允许用户自行安装来路不明版本
- [ ] **令牌不落盘**：模式 B 若启用，需专项安全评审
- [ ] **技能发布审核**：团队级/全公司级技能需管理员审核后才能共享

### 8.3 与业务部门的协作请求（低成本版）

不要求他们做 MCP，只要求两件事：

1. **接受自定义请求头** `X-DSH-Agent`，并在访问日志中记录（便于双方对账）
2. **系统改版时提前通知**（可以只是一个邮件组）

这两件事的成本接近于零，接受度远高于"请建一个 MCP 服务"。

---

## 9. 技术栈与仓库参考

| 组件 | 选型 | 说明 |
|---|---|---|
| 浏览器扩展 | Chrome Extension MV3 | content script + background service worker + side panel UI |
| 页内执行 | `chrome.scripting.executeScript({ world: 'MAIN' })` | 进入页面上下文，绕过 isolated world 限制 |
| 网络捕获 | `chrome.webRequest` + `chrome.debugger`(CDP) | 前者拿 header，后者拿 response body |
| DOM 感知参考 | `microsoft/playwright-mcp` 的 AX 快照思路 | 借鉴其 ref 机制，但在扩展内实现 |
| 网络捕获参考 | `AgentDeskAI/browser-tools-mcp` | 真实 Chrome 会话桥接、凭证脱敏的做法可直接借鉴 |
| | `sfgarza/network-capture-mcp` | 流量捕获与查询 |
| 元素定位参考 | `browser-use` 的 DOM 索引压缩 | SoM 编号思路 |
| 后端 | Java/Go/Python 均可 | 技能存储、意图路由、审计 |
| LLM | 内网 DeepSeek | 仅用于意图路由 + 参数抽取 + 录制辅助 |
| 视觉（预留） | UI-TARS-1.5-7B / Qwen3-VL | 单卡可部署，与主脑独立，暂不启用 |

---

## 10. 路线图

### Phase 0 · 可行性验证（2 周）
- [ ] **合规定性确认**（与安全/法务）—— 阻塞项，最先做
- [ ] 选定试点：**物品出门申请**（流程固定、价值明确、风险可控）
- [ ] 技术验证：Chrome 扩展在该系统上完成一次页面内同源提交
- [ ] 验证 CSRF/ViewState 提取是否可行
- [ ] 产出：一个能跑通的 demo + 合规结论

### Phase 1 · 单技能硬编码打通（3 周）
- [ ] MV3 扩展骨架（content script / background / side panel）
- [ ] 页内同源执行器（模式 A）
- [ ] 出门条技能硬编码实现，端到端跑通
- [ ] 用户确认弹窗 + 执行留痕
- [ ] 接入 DeepSeek 做意图识别与参数抽取
- [ ] **交付：真实用户可用的第一个技能**

### Phase 2 · 录制器（5 周）
- [ ] 双通道录制（UI 动作 + 网络请求）
- [ ] 请求过滤与关联分析
- [ ] 参数化向导（启发式 + LLM 辅助）
- [ ] 老系统预处理器（ViewState / CSRF / Struts）
- [ ] 二次录制验证
- [ ] 断言配置（可视化选取）
- [ ] **交付：非开发人员可自己录一个技能**

### Phase 3 · 执行引擎与自愈（4 周）
- [ ] 技能存储与版本管理
- [ ] 双通道执行 + 降级链
- [ ] 元素指纹匹配引擎
- [ ] AX Polyfill 注入
- [ ] 人工接管 + 回灌录制
- [ ] 每日巡检 + 健康度告警

### Phase 4 · 平台化（5 周）
- [ ] 技能市场（我的/团队/全公司）
- [ ] 技能编辑器（步骤增删改、版本回滚）
- [ ] 工作流编排（多技能串联）
- [ ] 治理后台（审核、审计、大盘）
- [ ] 企业策略分发

**总计约 19 周（4.5 个月）。**

关键节奏：**Phase 1 结束就要有真实用户在用**。拿真实使用数据去推动后续资源和部门协作，比拿方案文档有用得多。

---

## 11. 给实施方（GPT / 编码助手）的任务清单

### A · 扩展底座
- **A1** MV3 扩展骨架：manifest、content script、background service worker、side panel
- **A2** 页内执行桥：`world:'MAIN'` 注入 + postMessage 通信协议
- **A3** 同源请求执行器：支持 form-urlencoded / JSON / multipart
- **A4** CSRF/ViewState 自动提取器（覆盖 ASP.NET MVC、WebForms、Spring Security、通用 meta 标签）
- **A5** 企业策略分发配置（Chrome Enterprise Policy 模板）

### B · 感知层
- **B1** AX Polyfill 注入脚本（见附录 A）
- **B2** 语义 DOM 压缩器：输出编号列表，单页 < 3000 token
- **B3** 元素指纹生成器：提取多维特征
- **B4** 指纹匹配引擎：加权打分 + 唯一性校验 + 自愈回写
- **B5** 稳健操作原语：`robustClick` / `clickByText` / `setInputValue` / `scrollToFind`

### C · 录制器
- **C1** UI 动作录制：捕获 click/input/change/select，生成指纹
- **C2** 网络请求录制：`webRequest` + `chrome.debugger` 拿 body
- **C3** 请求过滤器：剔除静态资源、埋点、心跳、轮询
- **C4** 动作-请求关联分析（时序 + 因果推断）
- **C5** 参数化向导：启发式候选 + LLM 命名 + 用户确认 UI
- **C6** 老系统模式识别（ViewState / Struts / HTML 响应）
- **C7** HTML 响应解析规则生成（用户可视化选取）
- **C8** 二次录制差分验证

### D · 执行引擎
- **D1** 技能 Schema 定义 + 存储 + 版本管理
- **D2** 模板引擎（`{{param}}`、循环、条件、过滤器如 `date:yyyy-MM-dd`）
- **D3** network 通道执行器
- **D4** ui 通道执行器
- **D5** 降级链 + 重试策略
- **D6** 断言引擎（httpStatus / textPresent / jsonPath / regex extract）
- **D7** 人工接管 + 回灌录制

### E · 智能层
- **E1** 意图路由：用户输入 → 技能匹配（DeepSeek + 向量检索双路）
- **E2** 参数抽取 + 缺失参数反问
- **E3** 预览卡片生成
- **E4** 录制辅助：步骤命名、参数命名、描述生成

### F · 平台
- **F1** 技能市场 UI
- **F2** 技能编辑器 UI
- **F3** 工作流编排器
- **F4** 执行历史 + 留痕查询 + 重放
- **F5** 治理后台：审核队列、健康度大盘、审计导出
- **F6** 每日巡检任务

---

## 附录 A · AX Polyfill 注入脚本

给 Vue 裸 div 补语义，大幅提升 UI 通道可定位性。

```js
// inject-ax-polyfill.js  —— content script 在 document_start 注入
(function () {
  const CLICKABLE_CLASS = /(^|\s)(el-button|ant-btn|ivu-btn|arco-btn|van-button|layui-btn|btn)(\s|$|-)/;

  function looksClickable(el) {
    if (el.hasAttribute('role') || el.hasAttribute('data-dsh-role')) return false;
    if (CLICKABLE_CLASS.test(el.className || '')) return true;
    if (el.hasAttribute('tabindex')) return true;
    try { if (getComputedStyle(el).cursor === 'pointer') return true; } catch (e) {}
    return false;
  }

  function deriveLabel(el) {
    const t = (el.innerText || '').trim().slice(0, 40);
    if (t) return t;
    const icon = el.querySelector('i[class*="icon"], svg');
    if (icon) {
      const c = icon.className.baseVal || icon.className || '';
      const m = String(c).match(/icon-([\w-]+)/);
      if (m) return m[1];
    }
    return el.getAttribute('title') || el.getAttribute('placeholder') || '';
  }

  function enhance(root) {
    (root.querySelectorAll ? root : document)
      .querySelectorAll('div,span,li,td,a,i')
      .forEach(el => {
        if (!looksClickable(el)) return;
        el.setAttribute('data-dsh-role', 'button');
        const l = deriveLabel(el);
        if (l) el.setAttribute('data-dsh-label', l);
      });
  }

  function boot() {
    enhance(document);
    new MutationObserver(muts => {
      muts.forEach(m => m.addedNodes.forEach(n => {
        if (n.nodeType === 1) enhance(n);
      }));
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
```

> 注意：使用 `data-dsh-*` 而非直接改 `role`/`aria-label`，避免影响页面自身逻辑或真实无障碍行为。

## 附录 B · 稳健操作原语

```js
// 文本锚点 → 向上寻找可点击祖先
function findByText(text, { exact = false, nth = 0 } = {}) {
  const xp = exact
    ? `//*[normalize-space(text())="${text}"]`
    : `//*[contains(normalize-space(.),"${text}")][not(.//*[contains(normalize-space(.),"${text}")])]`;
  const snap = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  let el = snap.snapshotItem(nth);
  if (!el) return null;
  for (let i = 0, cur = el; i < 8 && cur; i++, cur = cur.parentElement) {
    if (['BUTTON', 'A'].includes(cur.tagName) ||
        cur.getAttribute('role') === 'button' ||
        cur.getAttribute('data-dsh-role') === 'button' ||
        getComputedStyle(cur).cursor === 'pointer') return cur;
  }
  return el;
}

// 稳健点击：直接派发事件，绕过遮罩/动画/fixed 定位干扰
function robustClick(el) {
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  const o = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerdown', o));
  el.dispatchEvent(new MouseEvent('mousedown', o));
  el.dispatchEvent(new PointerEvent('pointerup', o));
  el.dispatchEvent(new MouseEvent('mouseup', o));
  el.dispatchEvent(new MouseEvent('click', o));
}

// 输入并触发 Vue/React 响应式
function setInputValue(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}
```

---

**文档结束**
