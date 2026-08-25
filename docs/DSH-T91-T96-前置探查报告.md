# DSH T-91~T-96 前置探查报告

日期：2026-08-23
执行者：GLM（测试角色，只读探查）
性质：**不改任何产品代码**；全部探针脚本在 `tmp/` 下，可复跑
范围：B2 联动数据形态（→T-96）、C 会话生命周期（→T-93）、B1 bearer 探测（→T-92）
A 项（OA 加标准 Element 表单项考 T-84）**未做**——需要改 OA 前端代码，与本次「不改代码」约束冲突；已有的旁证与替代方案见文末附录。

复跑方式：
```bash
node tmp/b2-linkage-capture.mjs        # B2 王海链路
node tmp/b2-zhangsan-ambiguous.mjs     # B2 张三重名链路
node tmp/c1-jwt-refresh.mjs            # C JWT+前端源码
node tmp/c3-persistence.mjs            # C 关浏览器重开
node tmp/c4-dual-profile.mjs           # C 双 profile 互踢
node tmp/c5-realm-config.mjs           # C Keycloak realm 配置
node tmp/b1-bearer-strategies.mjs      # B1 四策略+auth/me
node tmp/b1-probe-sim.mjs              # B1 probeSession 判定模拟
```

---

## B2 · 联动请求真实数据形态（T-96 的直接输入）

### B2.1 加班表单「审批人搜索→提交」完整链路（无重名：王海）

用户操作：输入「王海」（逐字 `pressSequentially`，delay 300ms）→ 下拉 1 条 → 点选 → 提交。
网络侧共 10 个请求，其中**关键链 3 个**，**表单加载噪音 5 个**，**导航噪音 2 个**。

#### 关键链请求原文

**① 逐字输入的中间态搜索（「王」）**
```
GET /api/employees/search?keyword=%E7%8E%8B    (即 keyword=王)
→ 200
{"code":0,"message":"ok","data":[
  {"id":"EMP006","empNo":"EMP006","name":"王璐","department":"法务合规部","position":"法务专员","gender":"female"},
  {"id":"EMP007","empNo":"EMP007","name":"王海","department":"产品研发中心","position":"研发总监","gender":"male"},
  {"id":"EMP030","empNo":"EMP030","name":"王强","department":"法务合规部","position":"市场专员","gender":"male"},
  {"id":"EMP051","empNo":"EMP051","name":"王超","department":"人力资源部","position":"Java工程师","gender":"male"},
  {"id":"EMP084","empNo":"EMP084","name":"王超","department":"法务合规部","position":"Java工程师","gender":"male"},
  {"id":"EMP089","empNo":"EMP089","name":"王敏","department":"财务共享中心","position":"财务专员","gender":"male"},
  {"id":"EMP115","empNo":"EMP115","name":"王秀兰","department":"财务共享中心","position":"产品经理","gender":"female"},
  {"id":"EMP130","empNo":"EMP130","name":"王超","department":"产品研发中心","position":"数据分析师","gender":"female"},
  {"id":"EMP135","empNo":"EMP135","name":"王秀英","department":"技术平台部","position":"前端工程师","gender":"female"},
  {"id":"EMP142","empNo":"EMP142","name":"王敏","department":"市场营销中心","position":"行政专员","gender":"female"}
]}
```

**② 最终态搜索（「王海」，精确命中 1 条）**
```
GET /api/employees/search?keyword=%E7%8E%8B%E6%B5%B7    (即 keyword=王海)
→ 200
{"code":0,"message":"ok","data":[
  {"id":"EMP007","empNo":"EMP007","name":"王海","department":"产品研发中心","position":"研发总监","gender":"male"}
]}
```

**③ 提交（联动消费点）**
```
POST /api/applications/overtime
REQ-BODY: {"overtimeType":"WEEKDAY","date":"2026-12-01","startTime":"18:00","endTime":"21:00",
           "project":"","reason":"B2链路捕获：王海审批人数据形态探查","hours":3,"members":[],
           "approverId":"EMP007","approverName":"王海"}
→ 200
{"code":0,"message":"ok","data":{"id":"OT-20260823-0053-567","bizType":"overtime","overtimeType":"WEEKDAY",
 "date":"2026-12-01","startTime":"18:00","endTime":"21:00","project":"","reason":"...","hours":3,"members":[],
 "approverId":"EMP007","approverName":"王海","applicant":"陈默","applicantId":"EMP010",
 "applicantDept":"产品研发中心","status":"pending","createdAt":"2026-08-23T13:33:24.531Z",
 "title":"工作日加班 3 小时（2026-12-01）","submittedAt":"2026-08-23T13:33:24.531Z"}}
```

#### EMP007 的 JSONPath 答案

- 搜索响应：**`$.data[0].id`**（data 是**裸数组**，不是 `{list:[...]}` 分页结构；精确搜索后目标即 `[0]`，但见 B2.3 重名节——不能假设 `[0]`）
- 逐字输入的中间态搜索（①）里是 `$.data[1].id`（王海排第 2）——**中间态与最终态的数组位置不同**
- 提交 body 里的 `approverId` 对应关系：`$.data[*].id`（需按 name+department 匹配，不能按位置）

#### 噪音请求清单（T-96 关联时应排除）

| # | 请求 | 触发时机 | 性质 |
|---|---|---|---|
| 1 | `GET /api/auth/me` | 页面加载/路由进入 | 噪音（会话） |
| 2 | `GET /api/dashboard` ×2 | 进入工作台 | 噪音（导航） |
| 3 | `GET /api/dept-tree` | 打开加班表单 | 噪音（表单初始化） |
| 4 | `GET /api/projects` | 打开加班表单 | 噪音（项目下拉预取） |
| 5 | `GET /api/employees?name=&department=&page=1&pageSize=20` ×2 | 打开加班表单（协作者选择器预取） | 噪音，但**与搜索 API 同域同语义**——注意：它返回的是**分页结构** `$.data.list[*]`，与搜索 API 的裸数组**结构不同**，是两个不同端点，不能混淆 |

注意⑤：全量 employees 一次拉 300 条含 idCard/bankNo 等敏感字段（脱敏契约 sanitize 对它同样适用，但指纹等值匹配的误碰面大——T-96 的 value-match 应限定在 search 端点的响应内匹配）。

### B2.2 重名场景（张三 ×2）——V-96-4 护栏可行性

搜索「张三」（一次性 `fill`，不逐字）：
```
GET /api/employees/search?keyword=%E5%BC%A0%E4%B8%89    (即 keyword=张三)
→ 200
{"code":0,"message":"ok","data":[
  {"id":"EMP001","empNo":"EMP001","name":"张三","department":"技术平台部","position":"高级Java工程师","gender":"male"},
  {"id":"EMP002","empNo":"EMP002","name":"张三","department":"财务共享中心","position":"财务专员","gender":"male"}
]}
```

选中第 2 条（.nth(1)）后提交：
```
POST /api/applications/overtime
REQ-BODY: {...,"approverId":"EMP002","approverName":"张三"}
→ 200 （approverId 正确指向 EMP002）
```

**「选中的是哪条」的可判别特征**（V-96-4 的实现依据）：

1. **选项 DOM 无序号/index 属性**：`.staff-option` 只有 `data-v-da9b91d1`（scoped hash）和 `class`，无 `data-index`：
```html
<div class="staff-option">  <!-- ×2，结构完全同构 -->
  <span class="chip-avatar">张</span>
  <span class="option-info">
    <span class="option-name">张三</span>
    <span class="option-meta">技术平台部 · 高级Java工程师</span>  <!-- ← 唯一区分：department+position 文本 -->
  </span>
</div>
```
2. **唯一稳定判别对 = `name + department`**（position 也在 DOM 但 API 响应与 DOM 都有 department；id 只在响应里，不在 DOM 里）
3. **选中后 chip 文本**含 department：`张三 · 财务共享中心`（`.chip-text`）——回放后可从 chip 反查选中了谁
4. **提交 body 的 approverId 是最终真值**——选错人时 id 不同（EMP001≠EMP002），事后审计可判

**T-96 设计含义**：录制时若搜索结果 >1 条且用户点了某条，护栏应记录 `(name, department) → id` 三元组（从搜索响应取）；回放时若同 keyword 的响应里该 `(name,department)` 对不存在或 id 变了 → 拦截。只记 id 不够（回放换了 keyword 就废），只记 name 不够（重名），**name+department 是最小判别键**。

### B2.3 给 T-96 response-value-match 的三条硬结论

1. **值链是存在的且可机器匹配**：搜索响应 `$.data[*].name="王海"` → 提交 body `approverName:"王海"`；`$.data[*].id="EMP007"` → body `approverId:"EMP007"`。当前实现只匹配 time-window 是因为 e2e 用例的 Mock 形态（`/api/overtime/approver` 专用端点）与真实形态（通用 search 端点+客户端选择）不同。T-96 需要覆盖「响应数组元素字段 → 后续写请求 body 字段」的映射。
2. **中间态搜索是干扰源**：逐字输入产生 N 个渐进 keyword 的搜索（王→王海），每个响应都含目标值。value-match 会命中多条——**取时间上最后一个含该值的搜索响应**（或 keyword 与参数等值的那个）。
3. **数组位置不可依赖**：中间态里王海是 `[1]`，精确态是 `[0]`。匹配必须按字段值（name/department），不能按 `$[N]` 下标。

---

## C · 会话生命周期实测（T-93 的直接输入）

### C.1 token 有效期（JWT 实测解码）

```
alg: RS256
iss: http://192.168.124.2:18085/realms/master
sub: 1222ce0d-0e16-40a4-bfeb-7ba3cbc4e1de
typ: Bearer
iat: 1787492078 (2026-08-23T13:34:38Z)
exp: 1790071701 (2026-09-22T10:08:21Z)
lifespan (exp-iat): 2,579,623s ≈ 29.9 天
payload keys: exp,iat,auth_time,jti,iss,aud,sub,typ,azp,sid,acr,allowed-origins,
              realm_access,resource_access,scope,email_verified,name,
              preferred_username,given_name,family_name,email
```

**access token 有效期 = 30 天**（realm 配置印证，见 C.5）。

### C.2 Keycloak realm 配置（admin API 只读获取，admin/admin 可登）

```
accessTokenLifespan:    2592000 (30天)
ssoSessionIdleTimeout:  2592000 (30天)
ssoSessionMaxLifespan:  2592000 (30天)
accessCodeLifespan:     2592000 (30天)
revokeRefreshToken:     false
refreshTokenMaxReuse:   0
```

**四项全部 30 天**。⚠️ 这是测试 Realm 的宽松配置；真实内网 Keycloak 通常是 access 5min / idle 30min——**T-93 设计不能按 30 天假设，但本环境实测下结论有效**（见 C.6 设计含义）。

### C.3 前端刷新行为（源码实测，src/stores/auth.ts）

```js
kc = new Keycloak({ url: KC_BASE, realm: KC_REALM, clientId: KC_CLIENT });
await k.init({ onLoad: "check-sso", pkceMethod: "S256" });   // 静默续期不跳登录页
if (k.authenticated && k.token) {
  this.token = k.token;
  localStorage.setItem("oa.token", k.token);
  await this.fetchMe();
  setInterval(() => { k.updateToken(60).catch(() => {}); }, 30000);  // ★ 每30s检查，剩<60s才真刷
}
```

- keycloak-js `check-sso` 模式：打开页面**不强制跳 Keycloak**，有 SSO cookie 就静默换新 token
- `updateToken(60)`：剩余有效期 >60s 时**不发请求**；≤60s 才刷新
- 401 处理（axios 拦截器）：`removeItem('oa.token')` + toast「登录状态已失效」+ 600ms 后跳 `#/login` + reload
- **token 只写 localStorage['oa.token']，无 sessionStorage、无 cookie（业务域）**

### C.4 关浏览器重开（实测）

流程：关 A → 3s → 重开同 profile → `#/dashboard`：

```
tokenStillInStorage: true
sameToken: false          ← keycloak-js check-sso 静默刷新，换了新 token
api-ok(200)               ← 新 token 调 /api/auth/me 成功
```

**结论：token 跨浏览器重启存活，且重开时会自动续新**（SSO cookie 在 192.168.124.2 域、30 天 idle）。

### C.5 双浏览器同账号（实测互踢）

A（real-oa profile）已登录 → 起 B（全新 profile real-oa-dual）完整走 Keycloak 登录 chenmo：

```
B final url: http://localhost:5173/#/dashboard（登录成功，token len 1413）
A after B login: {"sameToken":true,"apiStatus":200,"stillOnDashboard":"#/dashboard"}
```

**结论：不互踢**。Keycloak 默认允许同用户多会话并存（realm 未配 max sessions 限制，或配置宽松）。A 的 token 不被撤销。

### C.6 给 T-93 的四条硬结论

1. **`<FROM_BROWSER>` 方案在本环境完全成立**：token 在 localStorage 30 天有效 + 打开页面自动静默续期 + 双开不互踢。录制完技能过几天回放，`getLiveAuthHeader(storage)` 都能取到活 token。
2. **回放前不需要主动触发刷新**——但有一个例外路径：若用户清了浏览器 profile 或 SSO cookie 过期（30 天 idle），check-sso 判未认证 → 前端跳 #/login → 此时回放会撞登录页（对应实战报告 P1-B：引擎会傻等 5 分钟超时）。T-92 修复后应能识别 loginUrlPatterns 并给出「请重新登录」提示。
3. **401 的标准形态是 JSON**：`{"code":401,"message":"未登录或令牌缺失"}`（非 HTML 重定向）——T-92 的 requiresAuth 探测按状态码判即可，不用解析 body。
4. **真实内网迁移风险**：本 Realm 全 30 天是测试配置。T-93 的文档必须写明「本结论依赖 realm 的 30 天配置；若内网 access=5min，check-sso 的静默续期仍然有效（k.updateToken 由页面自身驱动），但 D5 无人值守需评估页面长期打开的内存/回调稳定性」——这是唯一需要现场再确认一项。

---

## B1 · bearer 探测实际形态（T-92 的直接输入）

### B1.1 bearerSource 四策略实测（getLiveAuthHeader 直调）

| 策略 | 调用 | 结果 |
|---|---|---|
| **storage**（默认正则 `token\|auth\|kc-`） | `{strategy:'storage', key:'token\|auth\|kc-'}` | ✅ **OK**，返回 `Bearer eyJhbGc...` len=1420 |
| **storage**（显式 key） | `{strategy:'storage', key:'oa.token'}` | ✅ OK（注意：key 按**正则**匹配，'oa.token' 中的 `.` 是任意字符，此处无害） |
| **storage**（无 key，用代码内默认） | `{strategy:'storage'}` | ✅ OK（代码默认即 `token\|auth\|kc-`，`oa.token` 命中 `token` 子串） |
| **global** | `window.keycloak.token` | ❌ null——kc 实例在模块闭包内，未挂 window；扫遍 window 也无 `ey...` 字符串变量（`[]`） |
| cdp-inherit | —（storage 已可用，无需） | 不适用但可行（此前实测过 Admin API 借头） |
| ui-only | — | 兜底（本系统不需要） |

**取到的 token 实测调 /api/auth/me → 200**。链路完整可用。

**T-92 结论**：真实 OA 的 bearerSource 正确配置就是 `{strategy:'storage', key:'oa.token'}`（或省略 key 用默认正则也命中）。**四策略里 storage 直接命中，无需 cdp-inherit**。当前引擎的 getLiveAuthHeader 实现没有缺陷——**缺陷只在 probeSession/readIdentityDigest 没有调用它**（见 B1.3）。

### B1.2 /api/auth/me 三种形态（完整原文）

**带 Authorization（有效 token）**：
```
GET /api/auth/me    Authorization: Bearer eyJ...
→ 200  application/json; charset=utf-8
{"code":0,"message":"ok","data":{"user":{"id":"EMP010","empNo":"EMP010","name":"陈默",
 "username":"chenmo","department":"产品研发中心","position":"高级产品经理"},"authMode":"keycloak"}}
```
- 身份字段 JSONPath：`$.data.user.username`（chenmo）或 `$.data.user.id`（EMP010）。**结构稳定**（同一端点也是 dashboard 初始化必调，前端 auth store 依赖它）
- `authMode:"keycloak"` 字段额外可判认证模式

**不带 Authorization**：
```
GET /api/auth/me
→ 401  application/json; charset=utf-8
{"code":401,"message":"未登录或令牌缺失"}
```
- **401 + JSON，非 302 非 HTML**——`www-authenticate` 头为 null（无 RFC6750 质询）
- probeSession 的 `response.json()` 对它不会抛错（它是合法 JSON）

**篡改签名 token**：→ 401（同形态）

### B1.3 T-92 requiresAuth 探测的实现判据（探针模拟验证）

模拟 probeSession 当前实现调 `/api/auth/me`（不带 Authorization）：

```
status=401, body={"code":401,...}（JSON 可解析）
probeSession 判定路径：401 ∉ okStatus[200] → false（unauthenticated）
```

**三条实现判据**：
1. **sessionProbe 探测**：fetch 前注入 `Authorization = await getLiveAuthHeader(page, entry.bearerSource)`，然后 GET `/api/auth/me`，200→authenticated / 401→unauthenticated。响应是 JSON，现有 `response.json()` 代码路径安全。
2. **identityProbe 探测**：同一端点，jsonPath=`$.data.user.username`，readIdentityDigest 同样注入 Authorization 后即工作。**identityProbe 配置应从 `/api/health $.code` 侧路改回 `/api/auth/me $.data.user.username`**（T-92 修好后）。
3. **401 不触发 HTML/重定向**意味着探测不会引发导航竞态——比 cookie 系统的 302 探测更安全，不需要 settleNavigation。

### B1.4 附带发现：dev 模式登录端点

`src/api/index.ts` 暴露 `POST /api/auth/login {username,password} → {token,user}`（`loginDev`，authMode≠keycloak 时用；本环境 KEYCLOAK_ENABLED=true 走 Keycloak 分支，此端点可能在后端仍可用——**未实测**，T-93/T-94 若需绕过 Keycloak 跳转可先探测它，但注意 C17 禁止技能含凭证，此端点只能用于测试基建（如 seedProfile），不能进技能）。

---

## 对 T-91~T-96 的影响汇总

| 任务 | 本次探查改变/确认了什么 |
|---|---|
| **T-92（bearer 探测）** | 实现路径完全确定：probeSession/readIdentityDigest 注入 getLiveAuthHeader 即可；探测端点用 /api/auth/me（401=JSON 不竞态）；bearerSource=storage/oa.token；identityProbe 改回 $.data.user.username。无未知数。 |
| **T-93（FROM_BROWSER）** | 本环境前提成立（30 天 token+自动续期+不互踢）。**无需回放前主动刷新**。风险仅一项：内网 realm 配置可能不同，文档需标注依赖。401 判据=状态码即可。 |
| **T-94（溯源护栏）** | B2.3 三条硬结论：值链可匹配（name+id 双字段）；中间态搜索取最后一个匹配响应；数组位置不可依赖。护栏数据结构应记 (name, department)→id 三元组。 |
| **T-96（response-value-match）** | **照着 B2.1 的原文就能写**：搜索响应 `$.data[*]`（裸数组）→ 写请求 body approverId/approverName 的字段级映射；排除同域分页端点 /api/employees（结构不同 $.data.list）；语义同形但结构不同的端点要区分。 |
| T-91/T-95 | 本次无直接输入（未涉及）。 |

---

## 附录 · A 项（T-84 考核）未执行说明与旁证

**未执行原因**：A 项要求在 OA 里**增加**标准 Element 表单项（label 无 for），需改 `E:/Web/replayer-web-test/web/src/views/*.vue`——超出本次「不改代码」授权。

**已有旁证（来自实战报告，可信度中等）**：
- 当前 OA label 79% 带 for（0-D 实测 11/14）——录制产物 8 步全 HIGH，从未产出 LOW
- 唯一 LOW 出现在 `produces.scope root`（`div > .el-form-item.is-required >> nth=0` 位置型）——scope 层的位置型选择器已真实出现过，只是不触发 T-84（T-84 管步骤 target，不管 scope root）
- remote-staff 审批人组件的 input（`.staff-input`）是自定义组件——它的 label 无 for（`工作交接人/审批人` 两项 for=null，0-D 数据可见），但录制时该 input 仍拿到 HIGH（placeholder 进了 accessible-name：`internal:role=textbox[name="输入姓名搜索审批人"i]`）——**说明 placeholder 是 label-for 缺失时的有效回退**，A 项预期中「无 for 必 LOW」可能不成立，考核价值反而在于验证这一点

**建议 A 项的执行方式**（下轮授权改 OA 后）：在 LeaveApplicationView 加 3 个字段——①无 for 的 el-form-item+纯 icon 按钮（考 visibleText=null）②两个同名 label（考 nth 漂移）③label 文案易改的文本框（考 T-84 文案断言）。复用 tmp/t1-final-record.mjs 的录制流程对照。

---

**文档结束**
