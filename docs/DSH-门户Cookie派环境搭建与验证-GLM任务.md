# DSH Browser Skill · 门户 / Cookie 派环境搭建与验证

版本：v1.0
日期：2026-08-23
执行者：GLM
性质：**搭建测试环境 + 只读验证**，不改产品代码
关系：**与 Codex 的 T-91~T-96 并行**，互不干扰

---

## 0. 为什么要做这件事

### 0.1 现状偏差

最近几轮所有"真实环境"验证，全部集中在同一种形态：

| 验证环节 | 认证形态 |
|---|---|
| 真实 OA 实战测试 | Keycloak + bearer + Vue3 SPA |
| B1 前置探查 | Keycloak token 四策略 |
| C 前置探查 | Keycloak realm 配置、keycloak-js 刷新 |

**除了自建 Mock（cookie 派），所有真实验证都是 bearer + SPA。**

而项目的目标环境是：

> 门户被指纹仪登录，用户点击子系统跳转过去，跳转带 `?token=`
> 部分老系统是 C# MVC 或 JSP

**这是 cookie 派 + 一次性令牌交换，跟 Keycloak bearer 是完全不同的一条路。**

### 0.2 完全没被验证过的能力

| 能力 | 实现状态 | 真实验证 |
|---|---|---|
| `via: portal` 门户跳转（T-56） | ✅ 已实现 | ❌ **从未验证** |
| 子系统会话由门户跳转建立 | ✅ 已实现 | ❌ **从未验证** |
| `?token=` 一次性令牌排除（C19） | ✅ 已实现 | ⚠️ 仅 Mock 极简页 |
| 门户会话 vs 子系统会话独立计时 | ✅ 已设计 | ❌ **从未验证** |
| 401 返回 302+HTML 时的四态判定 | ✅ 已实现 | ❌ **从未验证**（Keycloak 返回干净 JSON） |
| Legacy `__VIEWSTATE` preflight | ✅ 已实现 | ⚠️ 仅 Mock legacy 页 |

**`via: portal` 是目标环境的主路径，却是验证空白最大的一块。**

### 0.3 本任务目标

1. 确认 Keycloak 没有渗进产品代码（成为隐性默认假设）
2. 搭建一套模拟门户 + cookie 派子系统的测试环境
3. 在这套环境上验证上述六项空白能力
4. 产出三份并列的 entry 示例配置，消除"Keycloak 是默认形态"的错觉

---

## 1. 铁律

### 1.1 不改产品代码

- ❌ 不修改 `packages/` 下任何文件
- ❌ 不修改现有 Mock OA（`apps/mock-oa/`）——新环境独立建
- ❌ 不修改任何测试断言

发现产品缺陷只记录，不修复。修复是 Codex 的活。

### 1.2 不要让新环境太干净

搭建的模拟门户和子系统，**目的是复现困难，不是证明能跑通**。

具体要求见 §3.3 的"必须复刻的形态"。**如果搭出来的东西一次就跑通了，八成是搭得太干净了。**

已经踩过两次这个坑：Mock 最初用静态 id 导致结论作废；Mock 会话 cookie 加 `maxAge` 把真实困难删掉了。

### 1.3 与 Codex 并行不冲突

Codex 正在做 T-91~T-96，会改 `packages/browser`、`packages/analyzer`、`packages/replayer`。

**你的产出全部在**：
- `apps/mock-portal/`（新目录）
- `apps/mock-legacy-sys/`（新目录）
- `entries/example-*.yaml`
- `tmp/` 下的探针脚本
- 报告文档

**不碰任何 Codex 会改的文件。**

若测试中发现需要 Codex 修复的缺陷，写进报告，不要自己动。

---

## 2. Phase A · Keycloak 渗透自查【先做，五分钟】

在搭环境之前，先确认现有代码有没有把 Keycloak 当成默认假设。

### A.1 执行以下检查，贴原始输出

```bash
# ① Keycloak 相关标识
grep -rniE "keycloak|realm|openid-connect|kc-|oidc" packages/ --include="*.ts" | grep -v "\.test\.\|\.spec\."

# ② 是否假设 token 一定是 JWT
grep -rniE "eyJ|jwt|decodeToken|jose" packages/ --include="*.ts" | grep -v "\.test\.\|\.spec\."

# ③ 是否假设 401 一定返回可解析 JSON
grep -rn "response.json()\|res.json()" packages/browser/src/ packages/replayer/src/

# ④ 是否有 bearer 优先的隐性默认
grep -rniE "bearer|authorization" packages/ --include="*.ts" | grep -v "\.test\.\|\.spec\."

# ⑤ sessionType 的默认值与分支覆盖
grep -rn "sessionType" packages/ --include="*.ts"
```

### A.2 判读标准

| 检查项 | 可接受 | 需报告 |
|---|---|---|
| ① Keycloak 标识 | 只出现在 identityProbe 的**候选端点清单**里（那是个候选列表，无害） | 出现在探测逻辑、判定分支、默认值中 |
| ② JWT 假设 | 出现在 `getLiveAuthHeader` 的**候选筛选**中（用 JWT 形态过滤候选是合理的） | 作为"必须是 JWT"的硬校验 |
| ③ `response.json()` | 包在 try-catch 里，失败有降级路径 | 直接调用，失败即抛错 |
| ④ bearer 相关 | 在 `sessionType === 'bearer'` 分支内 | 无条件执行 |
| ⑤ sessionType | 四态分支都有实现 | 某一态没有对应处理 |

**③ 是重点**：Keycloak 的 401 返回干净 JSON，但老系统的 401 常常是 302 跳转到 HTML 登录页。若 `response.json()` 没有降级路径，那条路会崩。

### A.3 输出

```
Phase A · Keycloak 渗透自查
① Keycloak 标识:      __ 处   [可接受/需报告]
   位置清单:
② JWT 假设:           __ 处   [可接受/需报告]
③ response.json():    __ 处   有 try-catch __ 处 / 无 __ 处
④ bearer 无条件执行:  __ 处
⑤ sessionType 四态:   cookie=[有/无] bearer=[有/无] mixed=[有/无] unknown=[有/无]

结论: [无渗透 / 轻度渗透 / 严重渗透]
需 Codex 修复的项:
```

---

## 3. Phase B · 搭建门户 + Cookie 派子系统

### 3.1 目录结构

```
apps/mock-portal/          # 新增，独立端口 4000
  ├─ server.js
  └─ views/                # SSR 页面，不用前端框架
apps/mock-legacy-sys/      # 新增，独立端口 4100
  ├─ server.js
  └─ views/                # JSP 风格 SSR
```

**不要动 `apps/mock-oa/`。** 那是 Codex 的回归基线。

### 3.2 门户（mock-portal，:4000）

模拟"指纹仪认证 + 子系统跳转"，**不实现真的指纹仪**，用一个假登录页代替。

```
GET  /portal/login
     → 返回登录页 HTML（一个"模拟指纹认证"按钮即可）

POST /portal/login
     → 认证成功，种门户 cookie: PORTAL_SID
     → ⚠️ 关键：这是会话 cookie（无 Max-Age），关浏览器即失效
     → 302 到 /portal

GET  /portal
     → 门户首页，列出子系统入口链接
     → 未登录时 302 到 /portal/login
     → 链接形态：<a href="/portal/jump/legacy">Legacy 业务系统</a>

GET  /portal/jump/:sys
     → 校验门户会话
     → 生成一次性 token（随机、60 秒有效、用后即焚）
     → 302 到 http://localhost:4100/sso?token=<一次性token>

GET  /portal/api/session
     → 门户会话探测端点
     → 已登录 200 {"loggedIn":true,"user":"..."}
     → 未登录 401（⚠️ 见 §3.3 K-4，返回形态要能切换）

POST /portal/_debug/expire
     → 使门户会话失效
```

### 3.3 子系统（mock-legacy-sys，:4100）

**这是重点。必须复刻真实老系统的形态。**

```
GET  /sso?token=xxx
     → 校验一次性 token
     → 有效：种自己的 JSESSIONID（会话 cookie），token 立即失效，302 到 /home
     → 无效/已用：302 到门户 /portal（模拟"必须从门户进入"）

GET  /home
     → 业务首页 SSR HTML
     → 无 JSESSIONID → 302 到门户

GET  /form/apply
     → 申请表单页，SSR，含 __VIEWSTATE 与 __TOKEN 隐藏字段

POST /form/apply/submit
     → application/x-www-form-urlencoded
     → 校验 __VIEWSTATE 与 __TOKEN
     → 成功返回含"提交成功"的 HTML，写入 records

GET  /api/records?limit=N
     → JSON，返回已提交记录（供 postcondition 使用）

GET  /api/whoami
     → 身份探测端点，返回当前 session 对应的用户

POST /_debug/expire-sub
     → 只使子系统会话失效（门户会话保持有效）
```

#### 必须复刻的形态

| # | 形态 | 实现要求 | 为什么 |
|---|---|---|---|
| **K-1** | 一次性 token 用后即焚 | 第二次用同一 token → 302 到门户 | 验证 C19：重放必须失败 |
| **K-2** | 会话 cookie 无 Max-Age | 门户与子系统的 cookie 都不带 Max-Age | 真实企业系统常见配置，关浏览器即失效 |
| **K-3** | 两级会话独立计时 | 门户 60 分钟，子系统 5 分钟（可调） | 验证"子系统失效可静默重建" |
| **K-4** | **401 返回 302 + HTML** | 未认证访问业务页 → 302 到登录页 HTML，**不返回 JSON** | 验证探测在非 JSON 401 下的行为 |
| **K-5** | `__VIEWSTATE` 每次不同 | 每次 GET 表单页生成不同的 VIEWSTATE | 验证 preflight 不能硬编码 |
| **K-6** | 表单用原生控件 | `<select>`、`<input type=radio>`、`<input type=checkbox>` | 验证 T-94（Codex 正在修） |
| **K-7** | 无语义 div 按钮 | 提交按钮用 `<div onclick>` 加 hash class | 验证定位降级 |
| **K-8** | 部分 label 无 for | 一半带 for，一半不带且无 placeholder | 制造 LOW 样本，考核 T-84 |
| **K-9** | 服务端字段依赖 | submit 时校验某字段必须来自前一个 GET 的响应 | 验证依赖识别 |
| **K-10** | 提交后跳转列表页 | 成功后 302 到 /records | 验证 postcondition 推断 |

**K-4 和 K-8 是本次最重要的两条**：前者是探测逻辑的真空区，后者是 T-84 的真空区。

#### 环境开关

```
K-2 cookie 模式：  ?cookieMode=session | persistent  （默认 session）
K-4 401 形态：     ?authFailMode=redirect | json     （默认 redirect）
```

两种都要能测。

### 3.4 一键启动

```
apps/mock-portal/docker-compose.yml   或  npm script
npm run mock:portal      # 同时起 4000 与 4100
```

### 3.5 反向验证：确认环境"够难"

搭完之后，**先用最朴素的方式操作一遍，确认它会失败**：

```js
// 这些必须失败，否则环境搭得太干净
// ① 直接 goto 子系统深链（跳过门户）
await page.goto('http://localhost:4100/form/apply');
// 期望：被 302 到门户，拿不到表单

// ② 重放一次性 token
await page.goto('http://localhost:4100/sso?token=<已用过的>');
// 期望：被 302 到门户

// ③ 硬编码 __VIEWSTATE 提交
// 期望：校验失败
```

**三条都失败 = 环境合格。** 任一条成功，回头改环境。

---

## 4. Phase C · 门户链路验证

用刚搭好的环境，验证六项空白能力。

### C.1 entry 配置

创建 `entries/example-portal.yaml`：

```yaml
entry:
  id: portal-legacy
  name: 门户跳转 Legacy 系统
  via: portal
  portalUrl: http://localhost:4000/portal
  linkText: "Legacy 业务系统"
  landingUrlPattern: "^http://localhost:4100/home"
  excludeUrlPatterns:
    - "\\?token="
    - "/sso\\?"
  sessionType: cookie
  sessionProbe:
    url: http://localhost:4100/api/whoami
  identityProbe:
    url: http://localhost:4100/api/whoami
    jsonPath: "$.username"
  loginUrlPatterns:
    - "/portal/login"
  loginDomMarkers:
    - "#portal-login-form"
```

> ⚠️ 注意：`sessionProbe` 与 `identityProbe` 这里指向了同一端点。T-92 修复后 `parseEntry()` 应该会拒绝这个配置——**这本身就是一个要验证的点**（见 C.7）。先按上面写，观察行为。

### C.2 探测验证

```bash
dsh doctor --probe-entry --portal http://localhost:4000/portal --target legacy
```

**记录并回答**：

| 项 | 结果 |
|---|---|
| 是否识别出门户跳转链路 | |
| 是否检测到一次性 token 并加入 excludeUrlPatterns | |
| `sessionType` 判定 | |
| `cookieKind` 判定（session / persistent） | |
| `identityProbe` 是否自动发现 | |
| 通道能力 | network=? ui=? |
| `authFailMode=redirect` 下探测是否崩溃 | |

**重点**：把 `?authFailMode=json` 和 `?authFailMode=redirect` 各测一次，对比行为差异。

### C.3 ensureEntry 全流程

```
1. 清空 profile，全新启动
2. dsh record --entry portal-legacy
3. 观察：
   - 是否 goto 门户
   - 门户未登录时是否弹前台横幅
   - 手动完成门户登录后，是否自动点击"Legacy 业务系统"链接
   - 是否等到 landingUrlPattern
   - 一次性 token 跳转是否被排除（不出现在 record.json）
```

**逐项记录，特别是最后一条**（C19 的真实验证）。

### C.4 子系统会话静默重建

```
1. 完成 ensureEntry，进入子系统
2. 调 POST http://localhost:4100/_debug/expire-sub
   （只失效子系统，门户仍有效）
3. 触发一次业务操作
4. 观察：
   - 是否检测到子系统会话失效
   - 是否重走门户跳转重建（应该静默完成，不惊动用户）
   - 是否需要用户重新登录（不应该）
```

**这是"门户会话是真正生命线"这个设计的验证。**

### C.5 门户会话失效

```
1. 调 POST http://localhost:4000/portal/_debug/expire
2. 触发业务操作
3. 观察：
   - 是否弹前台横幅要求重新登录
   - 重新登录后是否能继续
```

### C.6 关浏览器重开（K-2 会话 cookie）

```
cookieMode=session（默认）：
  1. 完成登录，录一个技能
  2. 关闭浏览器
  3. 重开，尝试回放
  4. 期望：会话已失效，正确提示重新登录（不是静默失败或超时）

cookieMode=persistent：
  1. 同上
  4. 期望：会话存活，直接回放成功
```

**两种模式都要测。** 这直接对应 v3.1 §5 会话持有那一章的核心判断。

### C.7 惰性配置检测（若 Codex 已完成 T-92）

C.1 的 entry 里 `sessionProbe` 与 `identityProbe` 同 URL。

- 若 T-92 已合入 → 期望 `parseEntry()` 拒绝加载并报错
- 若 T-92 未合入 → 记录当前行为，作为 T-92 的验收前基线

然后改成分离的两个端点，确认能正常工作。

---

## 5. Phase D · Legacy 表单录制回放

### D.1 完整流程

```bash
dsh record --entry portal-legacy --out ./tmp/p1-legacy-form
dsh analyze ./tmp/p1-legacy-form --out ./skills/p1_legacy.draft.yaml
```

操作：从子系统首页 → 进申请表单 → 填原生 select / radio / checkbox → 填文本 → 提交

### D.2 draft 人工核对

| 核对项 | 记录 |
|---|---|
| `__VIEWSTATE` 是否被识别为 preflight（不是参数） | |
| preflight 的 extract 类型（应为 `dom`） | |
| 原生 select / radio 是否被录到 | |
| channel 分布 | network=__ ui=__ merged=__ |
| HIGH / LOW 分布 | |
| **LOW 步骤的 `visibleText`** —— K-8 的无 for 无 placeholder 字段 | |
| 是否有 `TODO_UNRESOLVED` | |
| postcondition 是否被推断（K-10 提交后跳列表） | |

**LOW 步骤的 visibleText 是本阶段重点**：K-8 故意造了无 for、无 placeholder 的字段，看它是否为 `null`。若为 null，说明 T-84 在这类字段上防护失效。

### D.3 回放与跨参数

```
1. 原参数回放 → 查 /api/records 确认落库
2. 换参数回放（换 select 的值）→ 查服务端确认类型跟随
3. 连续 5 次 → 确认每次恰好 +1
```

### D.4 K-9 依赖验证

K-9 设计了"submit 校验某字段必须来自前一个 GET 的响应"。

```
1. 观察 draft 中该字段是否生成了跨步引用 {{sN.xxx}}
2. 若被硬编码 → 换参数回放必然失败 → 记录
3. 若正确引用 → 换参数回放应成功
```

### D.5 T-84 语义漂移实测（K-8 字段）

```
1. 用 K-8 的 LOW 字段录一个技能
2. 修改子系统代码：把该字段的 label 文案改掉
3. 回放
4. 观察：T-84 是否拦住？报错信息是否可读？
```

若该字段的 `visibleText` 为 null，**T-84 无法拦截**——记录这个事实，这是防护真空区的实证。

---

## 6. Phase E · 三份并列 entry 示例

产出三份完整可用的 entry 配置，放在 `entries/` 下，**并列摆放消除"Keycloak 是默认"的错觉**：

```
entries/example-keycloak.yaml    # bearer + SPA（已有真实数据，整理即可）
entries/example-portal.yaml      # 门户跳转 + cookie（本次产出）
entries/example-legacy.yaml      # 直连老系统 + __VIEWSTATE（本次产出）
```

每份文件头部加注释说明适用场景：

```yaml
# 适用场景：统一认证中心（Keycloak/OIDC）+ 单页应用
# 特征：token 在 localStorage，401 返回 JSON，无门户中转
# 关键配置：sessionType: bearer，bearerSource.strategy: storage
```

**同时更新 `docs/entry-authoring.md`**（若存在），把三种形态并列介绍，不要以 Keycloak 为主线。

---

## 7. 报告格式

```markdown
# 门户 / Cookie 派环境验证报告

## 0. 执行摘要
（三到五句）

## 1. Phase A · Keycloak 渗透自查
（五条 grep 原始输出 + 判读表 + 结论）

## 2. Phase B · 环境搭建
### 2.1 已实现的形态
| # | 形态 | 实现方式 | 是否复刻成功 |
|---|---|---|---|
（K-1 ~ K-10 逐项）

### 2.2 反向验证（环境是否够难）
| 朴素操作 | 期望 | 实际 |
|---|---|---|
| 直接 goto 子系统深链 | 失败 | |
| 重放一次性 token | 失败 | |
| 硬编码 VIEWSTATE 提交 | 失败 | |

结论：[环境合格 / 太干净需加强]

## 3. Phase C · 门户链路验证
### C.2 探测（authFailMode 两种形态对比）
### C.3 ensureEntry 全流程（逐项）
### C.4 子系统会话静默重建
### C.5 门户会话失效
### C.6 关浏览器重开（两种 cookieMode）
### C.7 惰性配置检测

## 4. Phase D · Legacy 表单
### D.2 draft 核对表
### D.3 回放与跨参数（含服务端原文）
### D.4 K-9 依赖验证
### D.5 T-84 实测（K-8 字段）

## 5. Phase E · 三份 entry 示例
（文件清单 + 每份的关键差异说明）

## 6. 与 Keycloak 形态的差异清单
| 维度 | Keycloak/bearer | 门户/cookie | 产品是否都支持 |
|---|---|---|---|
| 认证入口 | | | |
| 会话载体 | | | |
| 401 形态 | | | |
| 会话建立方式 | | | |
| 会话生命周期 | | | |
| 身份探测 | | | |

## 7. 发现的问题
| # | 严重度 | 现象 | 复现 | 影响 | 归属任务 |
|---|---|---|---|---|---|
（严重度分级见 §8）

## 8. 未能完成的项及原因

## 9. 测试者判断
- 产品对 cookie/门户派的支持程度：[完整 / 部分 / 缺失]
- 相比 bearer 派，哪些能力有明显短板？
- 进内网前必须补的是什么？
```

---

## 8. 严重度分级

| 级别 | 定义 |
|---|---|
| **P0** | 静默错误：执行成功无报错但数据错误；或重复副作用 |
| **P1** | 阻断：cookie/门户派系统完全无法录制或回放 |
| **P1** | 安全机制失效：C19 一次性 token 被重放、C21 身份锁不生效 |
| **P2** | 失败但可发现：明确报错 |
| **P3** | 体验问题 |

**P0/P1 一律在报告开头单独列出，不要埋进明细。**

---

## 9. 注意事项

### 9.1 不要把困难删掉

搭环境时如果发现某个形态"很难实现"或"让测试跑不通"，**先判断真实系统里存不存在这个形态**：

- 存在 → 保留它，让产品去适应
- 不存在 → 才改环境，并在报告里说明判断依据

**K-2（会话 cookie 无 Max-Age）和 K-4（401 返回 302+HTML）尤其不要为了方便改掉**——这两个正是真实老系统的常态，也是当前验证的最大空白。

### 9.2 与 Codex 的边界

Codex 正在改 `packages/browser`、`packages/analyzer`、`packages/replayer`。

- 若你的验证依赖 T-92（bearer 探测修复）等未合入的能力，**记录"待 T-9x 合入后重测"**，不要自己实现
- 若 Codex 中途合入了某个修复，可以重跑受影响的验证项，并在报告中标注"基于 commit xxx"

### 9.3 报告诚实要求

- 区分「实测」「推断」「未验证」
- 未完成的项说明原因，不要推测后当作结论
- 环境搭建中的妥协要明确写出（例如"K-3 的两级计时用 60min/5min 而非真实值，因为无法获取真实配置"）

---

## 10. 一句话总结

> 产品的认证契约（sessionType 四态、bearerSource、sessionProbe/identityProbe、C19 排除）设计上是通用的，
> 但**所有真实验证都发生在 Keycloak + bearer 这一种形态上**。
> 目标环境的主路径——门户跳转 + cookie 派 + 一次性 token——从未被真实验证过。
> 本任务补上这块空白，并产出三份并列的 entry 示例，消除"Keycloak 是默认形态"的错觉。

---

**文档结束**
