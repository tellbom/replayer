# DSH Browser Skill · T-91 ~ T-96 · 实战问题修复

版本：v1.0
日期：2026-08-23
用途：交付 Codex 连续执行
上游：《DSH 真实 OA 实战测试报告》（GLM，2026-08-23）
关联：v2.0 规格约束 C1–C23；T-79~T-84 产品裁决；T-86~T-90 已交付

---

## 0. 本轮范围与边界

### 0.1 目标

修复真实 OA 实战测试暴露的四个 P1 与两个必要 P2。**目标是让 DSH 能在真实 bearer 系统上完成录制，而不是让它更好用。**

本轮排序原则：**可靠性 > 正确性 > 易用性**。任何只提升易用性的改动不在范围内。

### 0.2 任务清单

| # | 任务 | 严重度 | 工作量 |
|---|---|---|---|
| T-91 | a3-rebuild.spec 补 entryResolver | P2（但优先做） | 极小 |
| T-92 | 会话/身份探测支持 bearer + 拒绝惰性配置 | **P1 阻断性** | 大 |
| T-93 | Header 全量录制 + Authorization 占位 | P1 | 中 |
| T-94 | 原生 select / radio 捕获 + 字面量溯源护栏 | **P1** | 中 |
| T-95 | 录制导航竞态加固 + 增量落盘 | **P1** | 中 |
| T-96 | correlation 泛化到搜索响应链 | P1 | 中 |

**执行顺序固定**：T-91 → T-92 → T-93 → T-94 → T-95 → T-96。

**不需要中间停顿评审**，全部完成后提交一份合并报告。**两个例外见 §7.2。**

### 0.3 明确不做的事（已决策，不要提议）

以下均为已作出的产品决策，**本轮及后续不得实现，也不要在报告中建议**：

| 不做 | 决策依据 |
|---|---|
| **Chrome 扩展方案 / 双载体并行** | 逐项对比后确认：扩展在「读 POST body」「后台进程存活」「浏览器级弹窗」「版本兼容」四项上**可靠性低于 Playwright**，唯一占优的「页面跳转不崩溃」由 T-95 用 try-catch 解决。项目核心目标是稳定可靠而非易用，扩展方案无可靠性收益 |
| **`IBrowserDriver` 抽象层** | 预留扩展点本身也是适配化成本。既然确认不换载体，抽象层是纯开销——多一层间接、多一处潜在 bug、换来一个不会发生的迁移 |
| **自动修复 / 自愈增强** | 定位失败即报错，由用户重新录制。不承诺理解所有前端框架与 DOM 改版（T-79 §0 裁决） |
| **框架特化定位规则** | Element UI/Plus、Ant Design、Arco 等强适配一律禁止（T-79 §12） |
| **LLM 能力增强** | 本轮零 LLM 新增。回放路径保持零 LLM |
| **业务 Header 语义建模** | 不识别 `X-Project` 等业务头的含义，只做全量录制与原样回放。识别哪个头有什么用是人工看 draft 时的判断 |
| **无人值守 / 预授权** | 需要现场会话生命周期数据，条件未具备 |

### 0.4 通用禁止

- ❌ 不修改 v2.0 第二部分冻结契约（本文档明确允许的新增字段除外，见各任务）
- ❌ 不修改 Mock OA 或真实 OA 的业务代码使测试通过
- ❌ 不降低任何既有测试的断言强度
- ❌ 不因为"当前用例已修好"而跳过通用护栏的实现

---

## 1. T-91 · a3-rebuild.spec 补 entryResolver

### 1.1 问题

`e2e/acceptance/a3-rebuild.spec.ts:18` 调用 `parseSkill(text)` 只传一个参数，但 `parseSkill` 签名要求第二个参数 `entryResolver`（`packages/core/src/schema.ts:412`）。其它 spec 都经 `e2e/fixture.ts` 的 `entryResolver()`，唯独 A3 直调漏传。

该缺陷由 T-83 legacy 引擎移除时引入。

### 1.2 严重性说明（必须理解，不要因为改动小就轻视）

A3 是 v2.0 规格中明确标注的「整个 Demo 最核心的验收项」——整个项目的立项前提就是「Vue 每次 build 元素都变」。

**这个测试从 T-83 至今一直是坏的**：它在 skipped 名单里，即使被执行也会立即 TypeError 崩溃。跨越 T-84 ~ T-90 共七八个任务、三份完成报告，无人发现。

这不是一个 bug，是一个**流程漏洞的证据**：标记为核心验收的测试被 skip 后无人追踪。

### 1.3 交付

**① 修复调用**

补上 `entryResolver`，与其它 spec 保持一致（复用 `e2e/fixture.ts` 的实现，不要另写一份）。

**② 解决端口冲突**

实战测试发现两个环境问题：
- `scripts/a3-loop.mjs` 的 preview 绑定 5173，与真实 OA dev server 冲突
- `playwright.config` 的 `reuseExistingServer` 会复用 dev server，导致每次访问动态编译，class 断言必然失败

修法：A3 使用独立端口（建议 5199，可通过环境变量覆盖），并在该 spec 中禁用 `reuseExistingServer`。

**③ 核心验收 skip 高亮**

新增一个 CI 检查脚本 `scripts/check-critical-skips.mjs`：

```
维护一份核心验收清单（至少含 A3）
运行 e2e 后解析结果
若清单中任一项处于 skipped 状态
  → 在输出中以醒目格式单独列出
  → 退出码非 0（除非设置 ALLOW_CRITICAL_SKIP=1 并说明原因）
```

**这一项不是可选的。** 它防止同类问题再次潜伏七八个任务。

### 1.4 验收

| # | 项 | 期望 |
|---|---|---|
| V-91-1 | `npx playwright test a3-rebuild.spec.ts`（设 `A3_EXPECTED_CLASS`） | 不再抛 TypeError |
| V-91-2 | `node scripts/a3-loop.mjs` 完整 5 轮 | 5/5 通过；每轮 class 确实变化 |
| V-91-3 | 端口冲突 | 真实 OA 占用 5173 时，A3 仍可独立运行 |
| V-91-4 | skip 检查脚本 | 人为将 A3 置为 skip，脚本必须报错并高亮 |

---

## 2. T-92 · 会话/身份探测支持 bearer

### 2.1 问题

**这是本轮唯一的阻断性缺陷。**

`probeSession` / `readIdentityDigest` 在页面内 fetch 时**只带 Cookie，不带 Authorization**。同时 `response.json()` 对 HTML 响应抛错，导致非 JSON 探测端点恒返回 false。

后果：

```
dsh doctor --probe-entry --direct <真实OA>
  → sessionType: unknown
  → 通道能力: network ✗
  → 证据: Authorization=false Cookie=false

实际情况（人工深挖）：
  → sessionType: bearer
  → bearerSource: storage（localStorage['oa.token']，JWT RS256）
  → identityProbe 可用端点: /api/auth/me（$.data.user.username）
```

在真实系统上，`record` / `replay` 会卡在 LoginTimeout（5 分钟）后失败。

### 2.2 绕过方案造成的次生问题（比原问题更严重）

实战测试中，测试者把 `sessionProbe` 与 `identityProbe` 都指向了无鉴权的 `/api/health`。这让流程跑通了，但：

| 机制 | 侧路配置下的实际行为 |
|---|---|
| 会话过期检测 | **恒返回有效**，永远不会触发登录握手 |
| 身份锁（C21） | **digest 恒定**（实测 `stable=true`），任何人登录都是同一指纹，identityLock 形同虚设 |

**这不是"少了个功能"，是"配置看起来完整、机制实际惰性"。** 属于本项目一贯最警惕的静默失效类别。

内网现场几乎必然会重复这个绕过（否则什么都做不了），届时 C21 与 T-59 两道防线在真实部署里等于不存在。

### 2.3 交付

**① 探测请求注入 Authorization**

`probeSession` 与 `readIdentityDigest` 在发起页面内 fetch 前，先调 `getLiveAuthHeader`（T-57 已实现，`channel-network` 正在用，直接复用，**不要另写一份**）。

```
探测流程：
  1. 读取 entry.bearerSource（若无，先跑一次 sessionType 探测）
  2. 若 sessionType 为 bearer/mixed → getLiveAuthHeader() → 注入 Authorization
  3. 若为 cookie → 保持现状（credentials: 'include'）
  4. 发起探测请求
```

**② 非 JSON 响应不得直接抛错**

当前 `response.json()` 对 HTML 抛错导致探测恒 false。改为：

```
按序判断，不依赖 content-type：
  1. status 401/403 → 明确未认证 / 无权限（C13 四态，403 ≠ 未登录）
  2. status 2xx：
     a. 尝试 JSON.parse
        - 成功 → 按 jsonPath 判断
        - 失败 → 检查响应文本是否命中 loginDomMarkers
            命中 → unauthenticated
            未命中 → 无法判断，返回 unknown（不得乐观判为已认证）
  3. 其余 → unknown
```

**③ identityProbe 自动发现**

`dsh doctor --probe-entry` 应尝试常见身份端点并报告可用者：

```
候选（按序尝试，带 Authorization）：
  /api/auth/me
  /api/user/current
  /api/userinfo
  /realms/*/protocol/openid-connect/userinfo
  /api/me
```

找到可用端点后，在生成的 entry 草稿中填入，并标注推断出的 jsonPath（`$.sub` / `$.data.user.username` 等）。**产出打 `# TODO` 供人工确认。**

**④ 拒绝惰性 entry 配置【本任务最重要的一项】**

`parseEntry()` 新增校验，检测到以下任一情况**直接拒绝加载并报错**：

```
① sessionProbe.url === identityProbe.url
   → 报错：「sessionProbe 与 identityProbe 指向同一端点，
             身份变更将无法被检测（C21 失效）。请分别配置。」

② identityProbe 端点在不带 Authorization 时仍返回 2xx
   → 报错：「identityProbe 端点 <url> 无需认证即可访问，
             其返回值不随身份变化，identityLock 将形同虚设。
             请改用需要认证的身份端点（如 /api/auth/me）。」

③ entry.sessionType === 'unknown'
   → 报错：「sessionType 未探测。请先运行
             dsh doctor --probe-entry 并将结果写入 entry 配置。」
```

第 ② 条需要在 `dsh doctor --probe-entry` 阶段实测（发一次不带 Authorization 的请求看是否 2xx），结果记录在 entry 中：

```yaml
identityProbe:
  url: /api/auth/me
  jsonPath: "$.data.user.username"
  requiresAuth: true          # 【新增】由 doctor 探测填写
```

`requiresAuth: false` 时 `parseEntry()` 拒绝加载。

**⑤ 契约新增（允许）**

```ts
// EntrySchema.entry.identityProbe 增加
requiresAuth: z.boolean().default(false)
```

其余不得改动冻结契约。

### 2.4 验收

| # | 项 | 期望 |
|---|---|---|
| V-92-1 | 真实 bearer 系统 `dsh doctor --probe-entry` | `sessionType: bearer`，`bearerSource` 正确，`network: true` |
| V-92-2 | 真实 bearer 系统 `dsh record` | 不出现 LoginTimeout，能正常进入录制 |
| V-92-3 | identityProbe 自动发现 | 找到 `/api/auth/me` 类端点并生成带 TODO 的草稿 |
| V-92-4 | 惰性配置拒绝 ① | sessionProbe 与 identityProbe 同 URL → `parseEntry()` 抛错 |
| V-92-5 | 惰性配置拒绝 ② | identityProbe 指向无鉴权端点 → `parseEntry()` 抛错 |
| V-92-6 | 惰性配置拒绝 ③ | `sessionType: unknown` → `parseEntry()` 抛错 |
| V-92-7 | 403 不误判 | 已登录但无权限的端点 → `forbidden`，不触发登录握手（C13） |
| V-92-8 | 非 JSON 响应 | 探测端点返回 HTML 登录页 → `unauthenticated`；返回无法判断的 HTML → `unknown`，**不得判为已认证** |
| V-92-9 | 身份变更检测 | 用账号 A 建立会话记录 digest，换账号 B 登录 → digest 必须不同 |
| V-92-10 | cookie 系统回归 | Mock OA（cookie 会话）全部原有行为不变 |

**V-92-9 是本任务的核心**：证明修复后 identityLock 真的能工作，而不只是"代码存在"。

---

## 3. T-93 · Header 全量录制与 Authorization 占位

### 3.1 设计原则

**全录，不理解。**

系统不识别任何业务 header 的语义（不做 `X-Project` 之类的分类、不做参数化建议）。哪个头有什么用，是人工看 draft 时的判断。这样对任何系统都成立，零适配成本。

**唯一的例外是凭证类 header**，因为它们不能落盘。

### 3.2 三类 header 的处理

| 类型 | 匹配规则 | 落盘形态 | 回放时 |
|---|---|---|---|
| **凭证类** | `authorization`（大小写不敏感） | `"<FROM_BROWSER>"` | 调 `getLiveAuthHeader` 取活 token |
| **一次性令牌** | `x-csrf-token` / `x-xsrf-token` / `__requestverificationtoken` | `"<FROM_PREFLIGHT:name>"` | 由 preflight 机制提供 |
| **业务上下文** | 其余全部 | **原样存值** | 原样发送 |
| **浏览器自动头** | `cookie` / `host` / `content-length` / `sec-*` / `user-agent` / `accept-encoding` | **不存**（浏览器会自己带） | — |

### 3.3 为什么 Authorization 必须存占位而不是存值

两个实际原因，与安全洁癖无关：

**① Token 几分钟就过期**

Keycloak access token 默认 5 分钟。若把值写进 YAML：
```
今天录制 → 存进 YAML
半小时后回放 → 401
```
这不是"首次失效才要重录"，是几乎每次回放都失效。**存值的方案本身不可用。**

**② 技能文件失去可共享性**

`skills/` 是可进 git、可团队共享、可 code review 的配置目录。一旦含活 token：
- 不能提交（进 git 即永久泄漏）
- 不能分享（等于给账号）
- 不能贴日志、进 issue

**占位方案零额外适配**：录制侧加一条替换规则（几行），回放侧复用已有的 `getLiveAuthHeader`（T-57），**无新契约、无识别逻辑、无适配层**。

### 3.4 交付

**① 录制侧**

`RecordedRequest.headers` 保留全部 header（现有行为），但落盘前按 §3.2 规则替换凭证类。这一步走 `sanitize.ts`（C11：统一脱敏入口），**不得在 recorder 里另写一份替换逻辑**。

**② 分析器侧**

生成 draft 时，把业务 header 写入 step 的 `network.headers`：

```yaml
- id: s5
  channel: network
  network:
    method: POST
    url: /api/leave/submit
    headers:
      X-Project: "PRJ-001"              # 业务头，原样
      Accept-Language: "zh-CN"          # 业务头，原样
      Authorization: "<FROM_BROWSER>"   # 占位
      X-CSRF-Token: "<FROM_PREFLIGHT:csrf>"
```

**在 `_notes` 中提示人工检查**：

```yaml
_notes:
  - "本技能包含 2 个业务 header（X-Project, Accept-Language），
     值取自录制时。若这些值需要随调用变化，请手动改为参数引用。"
```

**不要自动参数化业务 header。** 系统不知道哪个头该变。

**③ 回放侧**

模板解析时识别两个占位符：

```
"<FROM_BROWSER>"           → getLiveAuthHeader()
"<FROM_PREFLIGHT:name>"    → ctx.vars[name]
```

取不到时：
- `<FROM_BROWSER>` 取不到 → 抛 `BearerUnavailableError`，outcome = `not_sent`（可安全降级，遵守 C12）
- `<FROM_PREFLIGHT:name>` 取不到 → 抛错，outcome = `not_sent`

**④ 落盘检查**

`skill-writer` 写入前扫描，若任何 header 值匹配 JWT 形态（`/^ey[A-Za-z0-9_-]+\./`）或 `Bearer ` 前缀，**拒绝写入并报错**。

### 3.5 验收

| # | 项 | 期望 |
|---|---|---|
| V-93-1 | 业务 header 保留 | 录制含 `X-Project` 的请求 → draft 中原样出现 |
| V-93-2 | Authorization 占位 | draft 中为 `<FROM_BROWSER>`，**grep 整个 skills/ 目录找不到任何 JWT** |
| V-93-3 | 回放注入 | 回放时实际发出的请求带正确的 Authorization（用 mock server 断言收到的头） |
| V-93-4 | Token 过期后 | 录制后使 token 失效 → 重新登录 → **回放成功，技能文件未改动** |
| V-93-5 | 浏览器自动头不落盘 | draft 中不含 `cookie` / `host` / `sec-*` / `content-length` |
| V-93-6 | 落盘检查 | 构造一个含 JWT 的 header 尝试写入 → 被拒绝并报错 |
| V-93-7 | 取不到 token | `getLiveAuthHeader` 返回 null → outcome = `not_sent`（可降级，非 `outcome_unknown`） |

**V-93-4 是本任务的价值证明**：用户只需重新登录，不需要重录技能。

---

## 4. T-94 · 原生 select / radio 捕获 + 字面量溯源护栏

### 4.1 问题

`recorder-probe` 的 `change` 监听只处理 `<input>` 与 `<textarea>`，漏两种形态：

| 控件 | 为什么漏 |
|---|---|
| 原生 `<select>` | 浏览器控件，点击不产生可捕获的 DOM 点击事件，只产生 `change`，而 change 分支不认它 |
| `el-radio` / `input[type=radio]` | 若有默认选中值，用户根本不点击，连一个动作都不产生 |

`el-select`（Element Plus）能录到，因为它本质是点 `.el-select-dropdown__item`，走 click 路径。

### 4.2 后果与 T-86 护栏的漏洞

值以字面量硬编码进请求体：

```yaml
body:
  leaveType: "PERSONAL"      # 写死，不是参数
```

传"年假"回放，照样提交事假。实战测试中参数识别正确率仅 **4/8**。

**关键：T-86 的护栏为什么没拦住。**

T-86 加的是「**声明了但未被引用**的参数 → 报错」，检查的是「声明 → 引用」这条链。而这里参数**压根没被声明**（探针没看见那个动作），链的起点就缺失，护栏不触发。

**这是同一失败模式从另一扇门进来。**

### 4.3 交付

**① 补两个 change 分支**

```
change 事件处理追加：
  el.tagName === 'SELECT'
    → emit({ type:'select', value: el.value,
             label: el.options[el.selectedIndex]?.text,
             target: __DSH_PWGEN__(el) })

  el.tagName === 'INPUT' && el.type === 'radio' && el.checked
    → emit({ type:'radio', value: el.value,
             label: 关联 label 文本,
             target: __DSH_PWGEN__(el) })

  el.tagName === 'INPUT' && el.type === 'checkbox'
    → emit({ type:'checkbox', value: el.value, checked: el.checked, ... })
```

**② 默认值捕获**

`el-radio` 有默认选中时用户不点击，因此录制开始时（`__DSH_RECORDING__` 置 true 后）**扫描一次表单初始状态**，记录所有已选中的 radio 与 select 的当前值，作为 `initialFormState` 写入 record。

分析器据此判断：若写请求体中的某个值等于某个控件的初始值，**仍应参数化**（用户只是没改它，不代表它是常量）。

**③ 回放侧对应动作**

`channel-ui` 补 `select` 与 `radio` 两个 action 的执行实现。原生 select 用 `selectOption`，radio 用 `check`。

**④ 字面量溯源护栏【本任务最重要的一项】**

即使补了这两个分支，将来仍会有别的控件形态漏掉。因此需要一条通用护栏：

```
draft 生成时，对每个 mutating 请求体的每个叶子字面量：
  尝试溯源到以下三者之一
    ① 用户录制时的输入/选择（含 initialFormState）
    ② 某个前置响应的提取值（跨步依赖）
    ③ preflight 变量
  三者都不匹配
    → 生成 TODO_UNRESOLVED
    → 在 _notes 中说明：
      「字段 leaveType 的值 "PERSONAL" 无法溯源。
        可能原因：该控件形态未被录制器捕获。
        请手动确认它应绑定哪个参数。」
    → parseSkill() 拒绝加载含 TODO_UNRESOLVED 的技能
```

**豁免清单**（这些字面量允许存在，不报错）：
- 值等于 URL 路径的一部分
- 布尔值 `true` / `false`
- 空字符串 / 空数组 / null
- 显式在 entry 或 skill 层声明为常量的字段

**这条护栏能拦住整类问题，而不只是 select/radio。** 请务必实现，不要因为"补了两个分支当前用例已经好了"而跳过。

### 4.4 验收

| # | 项 | 期望 |
|---|---|---|
| V-94-1 | 原生 select 录制 | 真实 OA 请假页选择类型 → record.json 中出现 `type: 'select'` 动作 |
| V-94-2 | radio 录制 | 点击 el-radio → 出现 `type: 'radio'` 动作 |
| V-94-3 | radio 默认值 | 不点击 radio 直接提交 → `initialFormState` 中记录了默认值，且该值被参数化 |
| V-94-4 | 参数识别率 | 真实 OA 请假流程 draft，参数识别 **≥ 7/8**（当前 4/8） |
| V-94-5 | 跨参数回放（无人工修正） | 录制事假 → **不做任何修正** → 传年假回放 → 服务端记录为年假（贴 history 原文） |
| V-94-6 | 字面量溯源护栏 | 人为在 probe 中禁用 select 捕获 → draft 生成 `TODO_UNRESOLVED` → `parseSkill()` 拒绝 |
| V-94-7 | 豁免清单 | 布尔值、空值、URL 片段不触发误报 |
| V-94-8 | 回归 | T-86 的 V-86-1 ~ V-86-5 全部保持通过 |

**V-94-5 是核心**：这是 T-86 V-86-2 在真实系统上的等价验收，同样要求「不做任何人工修正」。

---

## 5. T-95 · 录制导航竞态加固

### 5.1 问题

录制中页面跳转（会话失效跳登录页、Keycloak 重定向）时：

```
DSH 正在页面内执行代码（session.ts:97 的 __DSH_MUTATION__.end）
  → 页面开始跳转，执行上下文被销毁
  → 抛 "Execution context destroyed"
  → 进程退出
  → partial 全丢，record.json 都没生成
```

T-77 设计的会话中断八步处理（停止记录、冻结已录、提示登录、身份校验、续录、标记断点）**在第一步就崩了**，后七步没机会执行。

### 5.2 交付

**① 所有页面内 evaluate 加防护**

录制路径上每一处 `page.evaluate` / `exposeBinding` 回调内的执行，全部包 try-catch。捕获到执行上下文销毁类错误时：

```
不抛出、不退出
标记 navigationInProgress = true
等待 settleNavigation(page)（T-17 已实现）
导航稳定后判断新页面状态
```

**② 增量落盘**

当前是录制结束时一次性写 `record.json`，崩溃即全丢。改为：

```
每记录 N 个动作（建议 5）或每 T 秒（建议 10），
把当前 session 快照写入 <outDir>/record.partial.json

正常结束 → 写 record.json，删除 partial
异常退出 → partial 保留，且在文件中标记 { incomplete: true, reason }
```

CLI 启动时检测到同目录存在 partial → 提示用户是否恢复。

**③ 跳登录页时优雅停止**

`settleNavigation` 之后判断新页面：

```
命中 entry.loginUrlPatterns 或 loginDomMarkers
  → 立即置 __DSH_RECORDING__ = false（C16：登录动作绝不入库）
  → 冻结并落盘当前已录部分
  → 前台横幅：「会话已过期，请重新登录；登录后可继续录制」
  → 轮询等待 ensureEntry 完成
  → 身份校验（C21）：与录制开始时的 identityDigest 比对
       不一致 → 中止录制，保留已录部分并标记 identityChanged，不续录
       一致   → 继续
  → 提示：「页面状态可能已重置，请回到中断前的位置」
  → 恢复 __DSH_RECORDING__ = true
  → 在 record.json 标记断点：
     { type: 'session-interrupt', atActionIdx, resumedAt }
```

**④ 断点后不继承 scope（C22）**

分析器识别 `session-interrupt` 标记后：
- 该断点设为 `reentry.anchor` 候选
- **断点后的第一个动作不得继承断点前的 `requires`**（重新登录后弹窗/下拉面板早已消失）
- `_notes` 写明：「此处录制曾中断，前后步骤的 scope 关系不连续，请人工确认」

### 5.3 验收

| # | 项 | 期望 |
|---|---|---|
| V-95-1 | 跳转不崩溃 | 录制中 `localStorage.removeItem('oa.token')` 后点击导航 → 进程不退出 |
| V-95-2 | partial 保全 | 强制 kill 录制进程 → `record.partial.json` 存在且含已录动作 |
| V-95-3 | 登录动作不入库 | 中断后在登录页的所有点击 → **record.json 中不得出现**（C16） |
| V-95-4 | 续录 | 重新登录（同身份）→ 可继续录制 → record.json 含 `session-interrupt` 标记 |
| V-95-5 | 换身份中止 | 中断后用另一账号登录 → **中止录制**，标记 `identityChanged`，不续录 |
| V-95-6 | scope 不继承 | 断点后首个动作的 `requires` 为空 |
| V-95-7 | 恢复提示 | 存在 partial 时启动 record → 提示用户可恢复 |

---

## 6. T-96 · correlation 泛化到搜索响应链

### 6.1 问题

T-87 实现的 `request-value-match` 只在 Mock OA 的 `/api/overtime/approver` 这种形态触发（请求体含前一动作的选择值）。

在真实 OA 上（`remote-staff` 自定义组件远程搜索 + 通用列表接口），**7 个联动请求全部退化为 `time-window / low`**。

实战测试的关键观察：**慢节奏录制（每操作 ≥2.2s）无任何改善——「节奏不是 correlation 质量的变量，形态才是」。**

同时 Phase 5 中「点击列表行 → 详情请求」场景，`dom-causality / high` 首次触发成功。说明 DOM 因果路径可用，只是覆盖面不够。

### 6.2 缺失的匹配形态

真实系统的典型链路：

```
用户在审批人框输入「王海」
  → GET /api/employees/search?keyword=王海
  → 响应 [{ id:"EMP001", name:"王海", dept:"研发部" }]
  → 用户点选下拉中的「王海」
  → 后续 POST /api/leave/submit  body 含 approverId: "EMP001"
```

`EMP001` **明明出现在前面的响应里**，但当前实现匹配不上。原因是现有 `request-value-match` 只检查「后续请求体是否含前一动作的**输入值**」，不检查「后续请求体是否含前一**响应**的值」。

### 6.3 交付

**① 新增匹配策略：response-value-match**

```
对每个 mutating 请求 W：
  遍历 W 请求体的所有叶子值 v
    在此前所有响应体中深度搜索 v
      找到（且通过弱值过滤）
        → 建立依赖：W.body.<path> ← R<n>.<jsonPath>
        → 归属：W 关联到「触发 R<n> 的那个动作」的后继动作
        → _correlation.method = 'response-value-match'
        → confidence = 'high'
```

**必须复用 T-29 已有的弱值过滤规则**（空值、布尔、小整数、高频重复值、短字符串），不要另写一份。这是防止 `code=0` 这类值产生上万条假依赖的关键。

**② 匹配优先级（更新）**

```
1. dom-causality              高（响应值出现在页面 DOM 变更中）
2. response-value-match       高（响应值出现在后续写请求体中）← 新增
3. request-value-match        高（前一动作的输入值出现在请求体中）
4. time-window                低（兜底，必须打 TODO）
```

**③ 搜索类请求的特殊处理**

搜索请求（GET 且 URL 含 `search` / `query` / `keyword` 参数）的**请求参数本身也应参数化**：

```yaml
- id: s4
  desc: 搜索审批人
  channel: network
  network:
    method: GET
    url: "/api/employees/search?keyword={{审批人姓名}}"    # 参数化
    extract:
      approverId: "$[0].id"
      approverName: "$[0].name"
```

注意 `$[0]` 这个下标——**它与 T-86 禁止的 `{{s4[0].value}}` 不同**：

| | T-86 禁止的 | 这里允许的 |
|---|---|---|
| 形态 | `type: "{{s4[0].value}}"` | `extract: { approverId: "$[0].id" }` |
| 含义 | 取列表第一项作为**参数值** | 从搜索结果取第一条作为**依赖值** |
| 问题 | 与调用方参数无关，永远取同一项 | 搜索词本身是参数，结果随之变化 |

**但仍需护栏**：搜索结果条数 > 1 时，取第一条可能不是用户当时选的那条。因此：

```
若搜索响应是数组且长度 > 1
  → 记录用户实际选中的那一条的判别特征（如 name 完全匹配）
  → 生成带条件的提取：
     extract:
       approverId: "$[?(@.name=='{{审批人姓名}}')].id"
  → 若无法确定判别特征 → TODO_UNRESOLVED
```

实战测试中发现真实 OA 存在「两个张三」的重名情况，**这条护栏是必需的**。

**④ 低置信度必须显式标注**

`time-window` 兜底时，除 `_correlation.confidence: low` 外，draft 中必须有 TODO：

```yaml
# TODO: 此请求的归属由时间窗推断（置信度低）。
# 距最近前置动作 505ms，可能实际由更早的动作触发。
# 请确认它是否应归属于 s4「选择加班类型」。
```

### 6.4 验收

| # | 项 | 期望 |
|---|---|---|
| V-96-1 | response-value-match 触发 | 真实 OA 审批人搜索场景 → `_correlation.method = 'response-value-match'`，`confidence = high` |
| V-96-2 | 搜索词参数化 | 搜索请求的 keyword 参数被参数化，不是硬编码 |
| V-96-3 | approverId 溯源 | 不再出现 `approverId: TODO_UNRESOLVED`（有合法来源时） |
| V-96-4 | 重名护栏 | 搜索「张三」返回 2 条 → 生成条件提取或 `TODO_UNRESOLVED`，**不得静默取第一条** |
| V-96-5 | 弱值过滤保持 | 大响应中的布尔/小整数不产生假依赖（T-29 回归） |
| V-96-6 | time-window 兜底 | 无法用因果匹配时仍能归属，`confidence: low` + TODO |
| V-96-7 | 真实 OA 加班流程 | 7 个联动请求中，**≥ 5 个**达到 high 置信度（当前 0 个） |
| V-96-8 | 慢节奏一致性 | 慢节奏（≥2.2s）录制的 correlation 质量与快节奏一致 |

---

## 7. 执行与报告

### 7.1 提交方式

- 每个任务独立 commit：`fix(T-91): ...` 等
- 契约变更与实现可分 commit，但在同一 PR
- **不需要中间停顿评审**，六个任务连续执行

### 7.2 必须停下的两种情况

1. **V-92-2 未通过**（真实 bearer 系统仍无法进入录制）→ 停止，不继续 T-93。T-92 是本轮的阻断项，它不通过后面的验证都无法在真实系统上做。
2. **需要修改 v2.0 冻结契约**（本文档明确允许的 `identityProbe.requiresAuth` 除外）→ 停止，先提变更提案。

### 7.3 最终报告格式

```
T-91 a3 spec 修复
  V-91-1 ~ V-91-4:  PASS / FAIL
  a3-loop 5 轮:      __ / 5
  skip 检查脚本:      [已实现/未实现]

T-92 bearer 探测            ← 本轮核心
  V-92-1 doctor 探测:    sessionType=____ bearerSource=____ network=__
  V-92-2 真实系统录制:    PASS / FAIL
  V-92-3 identityProbe 发现: 端点=____ jsonPath=____
  V-92-4/5/6 惰性拒绝:    PASS / FAIL（三项分列）
  V-92-7 403 不误判:      PASS / FAIL
  V-92-8 非 JSON 响应:    PASS / FAIL
  V-92-9 身份变更检测:    digest A=____ digest B=____ 是否不同=__
  V-92-10 cookie 回归:    PASS / FAIL

T-93 Header 处理
  V-93-1 ~ V-93-7:       PASS / FAIL（逐项）
  skills/ 目录 JWT grep:  __ 处（必须为 0）
  V-93-4 token 过期后:    技能文件是否改动=__

T-94 select/radio + 溯源护栏
  V-94-4 参数识别率:      __ / 8（当前 4/8，目标 ≥7/8）
  V-94-5 跨参数无修正回放: PASS / FAIL
    服务端 history 原文:  ____
  V-94-6 溯源护栏:        PASS / FAIL
  其余逐项:               PASS / FAIL

T-95 导航加固
  V-95-1 ~ V-95-7:       PASS / FAIL（逐项）
  V-95-3 登录动作入库检查: record.json 中登录页动作数=__（必须为 0）
  V-95-5 换身份中止:      PASS / FAIL

T-96 correlation
  V-96-1 response-value-match: PASS / FAIL
  V-96-7 真实 OA high 置信度: __ / 7（当前 0/7，目标 ≥5/7）
  V-96-4 重名护栏:        PASS / FAIL
  其余逐项:               PASS / FAIL

回归
  unit:                  __ passed / __ failed
  e2e 全量:              __ passed / __ failed / __ skipped
    （skipped 逐项说明原因）
  T68-T74 + T84:         __ passed / __ failed
  audit:network:         PASS / FAIL

总结
  本轮状态:              ______
  遗留问题:              ______
  未能修复的项及原因:     ______
```

### 7.4 报告诚实要求

- 未通过的项如实标 FAIL，**不得**改测试或降低断言使其变绿
- skipped 单列说明原因，不计入通过
- 若某项修复后仍有残留问题，明确写出，不要含糊为「基本正常」
- 若发现本文档要求有误或不可实现，**说明理由并停下来问**，不要自行调整需求

---

## 8. 注意事项

### 8.1 修完必须证明它真的跑了

本轮暴露的问题里，有一半是「机制存在但从未被真正执行」：

- A3 测试崩溃了七八个任务无人知
- identityLock 在侧路配置下 digest 恒定，形同虚设
- 字面量硬编码进 body，T-86 的护栏够不着

**每一项修复都必须有一个能证明它真的生效的验收，而不是「代码写了」。**

具体到本轮：
- V-92-9（换账号 digest 必须不同）证明 identityLock 真的工作
- V-94-5（不做任何人工修正的跨参数回放）证明参数化真的对
- V-95-3（登录页动作数必须为 0）证明 C16 真的被遵守
- V-91-4（人为 skip 后脚本必须报错）证明门禁真的有效

### 8.2 通用护栏不能因为当前用例已修好而跳过

T-94 的字面量溯源护栏、T-92 的惰性配置拒绝、T-91 的 skip 检查脚本——这三项都是「当前 bug 修完之后仍然要做」的通用防护。

它们的价值不在修复当前问题，而在**让下一个同类问题响亮地失败而不是静默潜伏**。

### 8.3 不要扩范围

发现值得做但不在本轮范围的事情，**记录在报告的「建议」段落**，不要实现。特别是 §0.3 已明确决策不做的那些，**不要在报告中重新提议**。

### 8.4 v2.0 约束继续有效

本轮特别相关的：

| 约束 | 相关任务 |
|---|---|
| **C2** network 步骤在 `page.evaluate` 内 fetch | T-92 探测、T-93 回放注入 |
| **C8** 凭证不落 DSH 存储 | T-93 全程 |
| **C11** 落盘前统一经 `sanitize.ts` | T-93 不得另写替换逻辑 |
| **C12** 四态 outcome | T-93 取不到 token 时须为 `not_sent` |
| **C13** 403 ≠ 未登录 | T-92 探测四态 |
| **C16** 技能不含登录 | T-95 登录页动作不得入库 |
| **C21** 身份一致性校验 | T-92 惰性拒绝、T-95 换身份中止 |
| **C22** 重入从锚点重跑 | T-95 断点后不继承 scope |
| **C9** 浏览器侧零依赖 | T-94 probe 补分支 |

---

## 9. 一句话总结

> 回放引擎已在真实系统上验证扎实（20+ 次零重复、跨参数全对、network 免疫前端改版）。
> 本轮修的全部是**进入**的问题：进不去（T-92）、录不全（T-94）、录一半就丢（T-95）、录到了但关系不可信（T-96）。
> 三条通用护栏（skip 检查、惰性配置拒绝、字面量溯源）比修复本身更重要——它们决定下一个同类问题是响亮失败还是静默潜伏。

---

**文档结束**
