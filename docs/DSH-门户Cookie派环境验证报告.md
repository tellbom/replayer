# 门户 / Cookie 派环境验证报告

日期：2026-08-23 ~ 2026-08-24
执行者：GLM（测试角色）
依据文档：docs/DSH-门户Cookie派环境搭建与验证-GLM任务.md
环境：mock-portal（:4000）+ mock-legacy-sys（:4100）（本次新建，apps/ 下，未动 apps/mock-oa/）
探针脚本：tmp/pb-*.mjs、tmp/c[2-7]-*.mjs、tmp/d[1-5]-*.mjs（可复跑）

---

## P0/P1 问题速览（报告开头，不埋明细）

| # | 级别 | 现象 | 一句话影响 |
|---|---|---|---|
| **B-1** | **P0** | LOW 步骤（radio/checkbox，visibleText=null）在**语义漂移**（nth=1 指向不同控件）后回放 `ok=true` **静默通过** | T-84 防护对「无语义文本控件」完全失效——实战文档预言的真空区被实证（详见 §4.5） |
| **B-2** | **P1** | `probeSessionType` 只听 CDP `requestWillBeSent` 主事件，Cookie 头在 `requestWillBeSentExtraInfo`——cookie 派永远探测为 `unknown / network ✗` | cookie 派（目标环境主路径）在 doctor 阶段就盲 |
| **B-3** | **P1** | recorder 在「提交→302 跳转」导航竞态下崩溃（session.js:44 `__DSH_MUTATION__.end`），partial 全丢；**业务提交已落库**（records+1 但无 record.json） | 跳转型表单（K-10，真实老系统常态）录制必崩，且崩在副作用发生后 |
| **B-4** | **P1** | `getAuthState` 带 sessionApi 的 entry 在「302→登录页 HTML」形态下抛「认证状态未知」异常，不弹横幅不等人 | K-4 形态下 record 冷启动/daemon/session 三条路全断（c3e 卡死、daemon 崩溃均源于此） |
| **B-5** | **P1** | record 对 CDP attach 模式 IIFE 注入半失效（locator/snapshot/mutation 缺失，注入自检失败） | 常驻会话+外部驱动登录的官方出口（session-daemon 暴露 endpoint）与录制不兼容 |
| **B-6** | **P2** | `landingUrlPattern` 是子串语义（url.includes），任务文档示例 `^http://...` 正则锚定永不匹配 → waitForLanding 超时 | pattern 语法契约不明，容易写错且无校验提示 |
| **B-7** | **P2** | 原生 `<select>` change 不录制（P1-C 在 Legacy 环境复现）；K-8 无 for 无 placeholder 的 text input（ext）**整个动作丢失** | 参数识别缺口扩大：radio/checkbox 录到但 LOW，select/ext 干脆没有 |

---

## 0. 执行摘要

门户+cookie 派环境（K-1~K-10 全形态复刻）搭建成功且反向验证合格（三条朴素攻击全被拦）。在这套环境上：**会话生命线设计验证通过**——子系统失效后经门户静默重建 3.3s 无感恢复（C.4 PASS）、关浏览器两模式行为符合预期（C.6 PASS）、一次性 token 焚毁与 C19 排除生效。但暴露 **1 个 P0 + 4 个 P1**：T-84 对 visibleText=null 的 LOW 控件零防护（漂移后静默点错 radio 且 ok=true）；cookie 派探测、跳转型表单录制、302 登录页判定、CDP attach 注入四处主路径受阻。结论：**产品对 cookie/门户派的支持是「设计完整、实现有洞」——认证契约层面通用，但四条 P1 把 cookie 派的 doctor/record 冷启动全部堵死**，进内网前必须修。

---

## 1. Phase A · Keycloak 渗透自查

```
① Keycloak 标识:      6 处（src 非 test）[可接受]
   - bearer.ts:33 / probe-session.ts:78,94 —— 'kc-' 在 token 键名候选正则（候选筛选，无害）
   - probe-session.ts:97-101 —— keycloak.token 全局挂载候选（候选探测，无害）
   - 判定逻辑/默认值/分支中无 Keycloak ✅
② JWT 假设:           2 处 [可接受]
   - bearer.ts:28 /^ey…/ 仅用于非结构化 storage 值的候选筛选（JSON 对象分支不要求 JWT）
③ response.json():    browser/src 2 处（entry.ts:101,131），全部 try-catch + null 降级 [可接受，语义存疑]
   - ⚠️ 302→登录页 HTML→fetch 跟随→200 HTML→json() 抛→catch→null→判 unauthenticated
     「重定向后的 200 HTML」与「真会话 200 JSON」未区分（B-4 的深层原因之一）
④ bearer 无条件执行:  0 处 ✅（全部在 sessionType==='bearer'||'mixed' 分支内，channel-network.ts:37）
⑤ sessionType 四态:   cookie=[有] bearer=[有] mixed=[有] unknown=[有]
   - channel-network.ts:37/52 分支齐全；schema.ts:107 默认 unknown 且有阻断提示 ✅

结论: 无渗透
需 Codex 修复的项: 无（渗透层面干净）；但 ③ 的降级语义与 B-4 相关，见问题清单
```

---

## 2. Phase B · 环境搭建

### 2.1 已实现的形态（K-1~K-10）

| # | 形态 | 实现方式 | 是否复刻成功 |
|---|---|---|---|
| K-1 | 一次性 token 用后即焚 | mock-portal `.tokens.json` 文件共享 + used 标记，60s 有效 | ✅（重放被拦实测） |
| K-2 | 会话 cookie 无 Max-Age | PORTAL_SID/JSESSIONID 均无 Max-Age；`PORTAL_COOKIE_MODE/SUB_COOKIE_MODE=persistent` 开关对照 | ✅（C.6 双模式行为分化实测） |
| K-3 | 两级会话独立计时 | 门户 60min、子系统 5min，各自 Map 计时 | ✅（C.4 静默重建实测） |
| K-4 | 401 = 302 + HTML | 业务页未认证 → 302 门户；`?authFailMode=json` 切 JSON 401 | ✅（默认 redirect；JSON API 端点保持 JSON 401——与页面 302 分离，真实系统常态） |
| K-5 | __VIEWSTATE 每次不同 | 每次 GET 随机生成 viewstate/formToken/seqCode，会话级 pendingForm | ✅（反向验证③ + D.3 二次使用 400 实测） |
| K-6 | 原生 select/radio/checkbox | 表单全原生控件 | ✅（录制缺陷 B-7 因此暴露） |
| K-7 | 无语义 div 按钮 | `<div class="submitBtn_a1b2c_" onclick>` hash class | ✅（结构存在；点击录制因 B-3 未能验证） |
| K-8 | label 半数无 for | 设备类型/故障描述带 for；故障等级/配件/分机不带且无 placeholder | ✅（radio LOW + visibleText=null 实测，ext 丢失实测） |
| K-9 | 服务端字段依赖 | submit 校验 seqCode/__VIEWSTATE 必须来自本会话 GET | ✅（D.3 硬编码重放 400 实测） |
| K-10 | 提交后 302 跳列表 | 成功 → 302 /records | ✅（D.3 location 落 /records；同时触发 B-3） |

一键启动：`node apps/mock-portal/start-all.mjs`（4000+4100）；开关见环境变量。

### 2.2 反向验证（环境是否够难）

| 朴素操作 | 期望 | 实际 |
|---|---|---|
| 直接 goto 子系统深链 /form/apply | 失败 | ✅ 302 → 门户登录页 |
| 重放一次性 token | 失败 | ✅ 302 → 门户 /portal |
| 硬编码 VIEWSTATE 提交 | 失败 | ✅ 400「页面已过期…校验未通过」 |

结论：**环境合格**。（搭建中自纠一处：`JSON.stringify(Map)` 返回 `{}` 的 bug——token 白名单文件空导致 SSO 全拒，修复为 `Object.fromEntries`。）

---

## 3. Phase C · 门户链路验证

### C.2 探测（authFailMode 两形态对比）

| 项 | redirect 模式（默认） | json 模式 |
|---|---|---|
| doctor --probe-entry --portal | sessionType=**unknown**，cookieKind=unknown，network ✗ | 同左 |
| 已登录子系统后 probeSessionType | **仍 unknown**（B-2：CDP 主事件无 Cookie 头） | 同左 |
| 是否检测到一次性 token 加入 exclude | ❌ 无此能力（draft entry 不含 token 排除建议） | 同左 |
| identityProbe 自动发现 | ❌ 草稿 identityProbe 为空占位 | 同左 |
| 探测是否崩溃 | 不崩（返回 unknown） | 不崩 |

**B-2 证据链**：`ctx.cookies()` 可见 JSESSIONID/PORTAL_SID → CDP `requestWillBeSent` 主事件 headers.Cookie 为空 → `requestWillBeSentExtraInfo.headers.Cookie` 有值（`PORTAL_SID=...`）→ probeSessionType 只订阅主事件。**cookie 派探测在协议层就取不到证据**，与登录状态、401 形态无关（两模式结果相同佐证）。

### C.3 ensureEntry 全流程

| 观察 | 结果 |
|---|---|
| 是否 goto 门户 | ✅ |
| 未登录时是否弹前台横幅等人 | ⚠️ **部分**：ensureLoggedIn 的人等循环只在特定 state 下到达；门户 302→登录页形态下 `getAuthState` 返回 unknown → 抛「认证状态未知」异常（B-4），**横幅未及展示** |
| 用户登录后是否自动点子系统链接 | ✅（同 context 内手动登录协程 → 4.0s 全自动：门户→点链接→SSO→landing /home，authState=authenticated） |
| 是否等到 landingUrlPattern | ✅（修正 pattern 语法后，见 B-6） |
| 一次性 token 排除（C19） | ✅ **网络记录 0 泄漏、pages 记录 0 泄漏**（`?token=`/`/sso` 均未入 record.json） |
| record 冷启动（无预种子） | ❌ **卡死**：>7min 无输出、无 loginTimeout 抛错（B-4 深层：record 的等待路径与 ensureEntry 直调不同，死等无横幅） |
| 外部预种子 + record | ❌ 租约机制强制接管并关种子浏览器（TargetClosedError）——会话 cookie 蒸发。**产品设计本身封死此路**（对 persistent cookie 是可用路径，D 阶段即用此侧路） |
| session-daemon 路径 | ❌ daemon 死于 B-4 同源异常；state 卡 starting 不自愈；`dsh session status` 报「无会话」但不清理 state（P3） |
| CDP attach + record | ❌ B-5：IIFE 注入自检失败（locator/snapshot/mutation/ancestorScope undefined） |

### C.4 子系统会话静默重建【PASS，本次最大正面结论】

```
初始进入: http://localhost:4100/home
子系统会话已失效（门户仍活）
重建结果: authState=authenticated 3329ms | landing: http://localhost:4100/home
用户是否需要重新登录: 否
业务直访(失效后): 拿到表单(重建成功)
```

**门户会话是真正生命线的设计在真实跳转链路上验证成立**：子系统 5min 过期后 ensureEntry 经门户自动重跳 SSO，3.3s 静默恢复，全程无感。

### C.5 门户会话失效

```
门户会话已失效 → ensureEntry:
THROWN: 认证状态未知，probe 后仍无法判断 | at portal/login | 30800ms | bannerSeen=false
```

❌ 未达期望：应弹横幅等用户重新登录，实际 30.8s 后抛异常、横幅未出现。根因 B-4：`getAuthState` 的 sessionApi fetch 分支（auth.ts:8-40）在 unknown 时不走 `loginUrlPatterns`/`loginDomMarkers` 的页面级检测（那两个检查在 sessionApi 分支 return 之前永远到不了）。

### C.6 关浏览器重开（K-2 两模式）

| 模式 | 重开直访结果 | 期望 | 判定 |
|---|---|---|---|
| session（默认） | 302 → 门户登录页，会话失效 | 失效 | ✅ |
| persistent | 直达 /form/apply 表单 | 存活 | ✅ |

### C.7 惰性配置检测

T-92 未合入。基线：`parseEntry()` 接受 `sessionProbe` 与 `identityProbe` 同 URL（`/api/whoami`），无任何警告。**此输出即 T-92 验收前基线**——T-92 合入后同配置应被拒绝。

---

## 4. Phase D · Legacy 表单录制回放

### D.2 draft 核对表

| 核对项 | 结果 |
|---|---|
| `__VIEWSTATE` 识别为 preflight | ❌ **未生成 preflight**（录制流程未含提交段——B-3 规避；网络通道的 preflight 形态由 D.3 手工验证可行） |
| 原生 select 录制 | ❌ **丢失**（B-7，与真实 OA P1-C 同源缺陷） |
| radio/checkbox 录制 | ⚠️ 录到但 **LOW**（`internal:role=radio >> nth=1`、`internal:role=checkbox >> nth=0`） |
| channel 分布 | network=0 ui=2（navigate） merged=3 —— **network=0**：SSR 页面表单无 XHR，全部走 UI |
| HIGH / LOW | HIGH=1（textarea accessible-name「故障描述」） LOW=2 |
| **LOW 步骤 visibleText** | **两个均为 `null`**（visibleTextSource: none）——K-8 命中：无 for 无 placeholder 的 label 结构下，radio/checkbox 无可提取语义 |
| TODO_UNRESOLVED | 无 |
| postcondition 推断 | ❌ 未推断（K-10 跳转形态 + 录制未含提交） |
| K-8 的 ext（text input 无 for） | ❌ **fill 动作执行了但整个丢失**（比 LOW 更糟——labelFor 返回 null 时动作被丢） |

### D.3 回放与跨参数（network 通道形态）

UI 通道因 B-3 无法录完整提交链。以 network 通道形态手工验证（等价技能的 preflight+submit 两步）：

```
GET 表单页 → 提取 __VIEWSTATE/__TOKEN/seqCode
POST /form/apply/submit（依赖 GET 值） → 302 /records
服务端原文：{"total":1,"list":[{"id":"RC-0001","deviceType":"PRINTER","urgency":"URGENT",
 "desc":"D3 network 通道依赖链测试：打印机卡纸","parts":["SCREEN"],"ext":"8002",
 "seqCode":"SEQ-MT60MRDG","user":"EMP010","at":"2026-08-23T16:22:36.898Z"}]}
```
✅ 依赖链可行、落库正确。**注意**：POST 的 302 在页内 fetch `redirect:manual` 下是 opaque——network 通道 browserFetch 对 K-10 跳转型提交的断言需 Codex 关注（HTTP 断言可能拿不到 302/200 终态）。

### D.4 K-9 依赖验证

二次使用同一 VIEWSTATE 提交 → **400**（服务端拒绝）✅。
推论：network 技能若硬编码 VIEWSTATE 必失败，preflight dom-extract 是唯一正确路径——K-9 依赖设计被验证为「真实困难」。分析器本次未自动生成 preflight（录制未含提交段），**待 B-3 修复后重测自动推断**。

### D.5 T-84 语义漂移实测（K-8 字段）【P0 实证】

实验设计：录制时 `radio >> nth=1` =「紧急(URGENT)」；注入漂移（前置一个新 radio）后 `nth=1` =「一般(NORMAL)」（`{"name":"urgency","value":"NORMAL"}` 实测）。

```
回放结果: ok=true 4378ms，s3(radio) ✓ 通过，无任何告警
```

**结论：T-84 未拦截。** 漂移的 LOW 步骤静默点到了语义不同的控件（紧急→一般），回放整体 ok=true。防护链断点清晰：LOW 定位器生成时 `visibleText=null`（K-8 结构下 radio 无可提取文本）→ T-84 的语义断言无物可校 → 直接执行。**首跑 supervisedVerification 也只确认「位置能找到」，不校验语义。** 这是任务文档预言的防护真空区的直接实证，也是给 T-94 的最重要输入：护栏必须覆盖定位层（visibleText 为 null 的 LOW 步骤应视为不可发布，或强制人工标注语义）。

---

## 5. Phase E · 三份 entry 示例

| 文件 | 形态 | 关键差异 |
|---|---|---|
| `entries/example-keycloak.yaml` | bearer + SPA | sessionType: bearer，bearerSource.storage(oa.token)，identityProbe=$.data.user.username，401=JSON |
| `entries/example-portal.yaml` | 门户跳转 + cookie | via: portal + portalUrl/linkText，landingUrlPattern=4100/home（子串），loginDomMarkers=#portal-login-form |
| `entries/example-legacy.yaml` | 直连老系统 + VIEWSTATE | via: direct，sessionType: cookie，sessionProbe/identityProbe=/api/whoami，头部注明 K-5 需 preflight |

每份头部注释含适用场景/特征/关键配置/已知限制。`docs/entry-authoring.md` 不存在，未创建（任务文档为条件项；三份 entry 的头部注释已承载等价信息，避免与未来 Codex 文档冲突）。

---

## 6. 与 Keycloak 形态的差异清单

| 维度 | Keycloak/bearer（实测） | 门户/cookie（本次实测） | 产品是否都支持 |
|---|---|---|---|
| 认证入口 | Keycloak 登录页跳转回跳 | 门户登录页（指纹仪），点链接经 `?token=` 进子系统 | 设计上都有；**门户派 getAuthState 在登录页形态抛异常（B-4）** |
| 会话载体 | localStorage token（30 天） | 双层会话 cookie（门户 60min/子系统 5min，关浏览器即失效） | ✅ K-2/C.6 双模式均正确表现 |
| 401 形态 | JSON `{"code":401}` | 页面 302→HTML；JSON API 端点 JSON 401（分离） | ❌ 探测只兼容 JSON 形态（B-4）；cookie 证据取不到（B-2） |
| 会话建立方式 | check-sso 静默换 token | 一次性 token 焚毁 + JSESSIONID 种植 | ✅ ensureEntry 门户链路 4s 全自动（含自动点链接） |
| 会话生命周期 | 30 天 + 自动刷新 | 两级独立计时；子系统过期静默重建 | ✅ **C.4 是本次最大正面结论**（3.3s 无感恢复） |
| 身份探测 | /api/auth/me $.data.user.username | /api/whoami $.username | ✅ 端点层面等价可用 |
| 录制 | 可行（ bearer 侧路） | ❌ 跳转型表单崩溃（B-3）+ 冷启动卡死（B-4） | **cookie 派 record 主路径受阻** |
| C19 一次性令牌排除 | n/a | ✅ 0 泄漏 | ✅ |

---

## 7. 发现的问题

| # | 严重度 | 现象 | 复现 | 影响 | 归属任务 |
|---|---|---|---|---|---|
| B-1 | **P0** | visibleText=null 的 LOW 步骤在语义漂移后静默通过（点错 radio，ok=true） | tmp/d5-drift-replay.mjs + tmp/d5b（注入漂移→supervisedVerification 回放） | 语义漂移防护真空；错单风险（本例点错故障等级） | **T-94 必须覆盖定位层**（null-visibleText LOW 应不可发布或强制人工语义标注） |
| B-2 | **P1** | CDP 主事件 headers 无 Cookie（在 ExtraInfo）；cookie 派探测恒 unknown | tmp/c2-deep-probe.mjs、tmp/c2d-extra-info.mjs | doctor 对 cookie 派全盲，sessionType 靠人工填 | T-92（探测改造时一并修：订阅 requestWillBeSentExtraInfo） |
| B-3 | **P1** | 提交→302 导航竞态 recorder 崩溃（session.js:44），partial 丢且副作用已发生 | tmp/d1-record-legacy.mjs（两次复现；records+1 而无 record.json） | K-10 跳转型表单（老系统常态）不可录制 | 独立修复（实战报告问题3 的 Legacy 复现，加重：副作用后崩溃） |
| B-4 | **P1** | getAuthState 在 302→登录页 HTML 形态抛「认证状态未知」，不等人不弹横幅 | tmp/c3c/c3e/c5；daemon 崩溃 tmp/c3h | record 冷启动卡死、session-daemon 崩溃、C.5 期望落空——cookie 派三条主路径全断 | T-92 相关（认证状态判定需覆盖 302/HTML 形态 + 登录页检测分支优先于异常） |
| B-5 | **P1** | CDP attach 模式 IIFE 注入自检失败（4/5 全局缺失） | tmp/c3g-cdp-record.mjs | 常驻会话+外部驱动（session 官方出口）与录制不兼容 | 独立修复（attach 时对已有 page 补注入） |
| B-6 | **P2** | landingUrlPattern 子串语义，`^` 锚定写法永不匹配且无校验 | entries/example-portal.yaml 修正记录 | 配置易错、超时报错不指明原因 | T-92/T-94 文档+校验（pattern 语法契约化） |
| B-7 | **P2** | 原生 select change 不录制（复现 P1-C）；K-8 text input（无 for）动作整个丢失 | tmp/d1（actions 5 条 vs 实操 7 步） | 参数识别缺口：类型值硬编码、ext 字段缺失 | T-94/T-96（recorder-probe 补 HTMLSelectElement + labelFor 失败兜底） |
| B-8 | **P3** | session-daemon 死后 state 卡 starting；status 报「无会话」不清理 | tmp/c3h 后 .dsh/session-*.json | 状态文件残留误导 | 独立小修 |
| B-9 | **P3** | JSON.stringify(Map)=={} 使 token 白名单文件为空（本次环境自纠，非产品） | — | 已修复（Object.fromEntries），记录避免复踩 | — |

---

## 8. 未能完成的项及原因

| 项 | 原因 |
|---|---|
| D.1 完整录制（含 K-7 div 按钮点击与提交流程） | B-3 导航竞态崩溃（两次复现），退化为「填写段录制 + network 通道手工提交链」 |
| D.2 __VIEWSTATE 自动 preflight 推断 | 依赖上一条（录制未含提交段），待 B-3 修复后重测 |
| D.3 UI 通道跨参数回放 + 连续 5 次 | 技能无提交步骤（B-3 连带）；以 network 形态验证了依赖链与 K-9 拒绝，落库原文已贴 |
| C.3 record 冷启动横幅观察 | record 卡死无输出（B-4 深层），ensureEntry 直调路径已替代验证（4s 全自动） |
| K-7 div 按钮的定位降级验证 | 录制未达该步（B-3）；按钮结构已就位，待修复后一行脚本可补 |

---

## 9. 测试者判断

**产品对 cookie/门户派的支持程度：设计完整，实现有洞（部分支持）。**

- **契约层面是通用的**：sessionType 四态、via: portal、C19 排除、两级会话——设计没有 Keycloak 偏置（Phase A 无渗透）。
- **正面结论**：门户链路自动化（4s 全自动进入）、子系统静默重建（3.3s 无感）、C19 零泄漏、K-1/K-5/K-9 三道安全形态全部按设计工作。
- **相比 bearer 派的明显短板**（按伤害排序）：
  1. **探测层**：bearer 派至少 storage 策略可取 token；cookie 派连 CDP 证据都取不到（B-2），doctor 全盲。
  2. **冷启动**：bearer 派卡在 probeSession 401；cookie 派直接异常/卡死（B-4），三条路（record 直启/daemon/CDP attach）全断。
  3. **录制**：跳转型表单（老系统常态）崩溃（B-3）——bearer SPA 提交多为 XHR 无此问题。
  4. **防护**：T-84 对 K-8 结构真空（B-1，P0）——这一点两种派系同伤（真实 OA 也有原生 select），但 Legacy 表单的 label-less 密度更高、暴露面更大。

**进内网前必须补的（按序）**：
1. B-1（P0）：T-94 护栏覆盖定位层——visibleText=null 的 LOW 不可发布或强制人工语义标注；首跑 supervisedVerification 增加「语义核对」而非仅「位置可寻」。
2. B-4 + B-2（P1）：认证状态判定覆盖 302/HTML 形态（登录页检测优先于抛异常）+ CDP ExtraInfo 订阅——cookie 派 doctor/record 才能起步。
3. B-3（P1）：recorder 导航竞态加固（exposeBinding 内 evaluate 全 try-catch + 优雅停止落 partial）——副作用已发生而录制丢失是数据完整性事故。
4. B-5/B-7/B-8 随 T-92/T-94/T-96 顺带清理。

---

## 附：环境与复跑

```
启动：node apps/mock-portal/start-all.mjs        # 4000 + 4100，session cookie 模式
开关：PORTAL_COOKIE_MODE/SUB_COOKIE_MODE=persistent；?authFailMode=json（探测端点）
调试：POST /portal/_debug/expire、POST /_debug/expire-sub、GET /_debug/state
探针：tmp/pb-reverse-verify.mjs（反向验证）、tmp/c2*~c6*（Phase C）、tmp/d1/d3/d5*（Phase D）
还原：apps/mock-legacy-sys/server.js 已还原（漂移注入清除，grep 行政通道=0）
```

**文档结束**
