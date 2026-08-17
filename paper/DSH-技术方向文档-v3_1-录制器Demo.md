# DSH 内网自动化 · 技术方向文档 v3.1（录制器 Demo 版）

> 版本：v3.1 ｜ 日期：2026-08-17
> 合并并收敛 v1（调研）/ v2（平台方案）/ v3（录制器 Demo）
> **v3.1 相对 v3 的变更**：
> - 新增 §7「运行时载体与认证方案」——浏览器选型、登录握手
> - 新增 §8「LLM 接入设计」——推翻 v3 中「Demo 不接 LLM」的结论
> - 相应调整 Demo 边界、验收标准、路线图、任务清单
>
> **交付定义**：在公网开发环境中，做出一个能录制 Vue+Element Plus 业务流程、产出可人工修正的技能文件、并能以 LLM 为主脑稳定回放的**录制器 Demo**。内网验证通过后再迭代为框架。

---

## 0. 相对 v2 的收敛

| 维度 | v2（平台方案） | **v3.1（Demo）** |
|---|---|---|
| 交付物 | 用户自助技能平台 | **一个录制器 + 一个回放器 + N 个独立技能文件** |
| 用户 | 全公司自助创建 | **开发者手工录制、手工修正** |
| 技能生成 | 全自动参数化 | **半自动：录制器给草稿 + LLM 辅助标注，人工定稿** |
| 通用性目标 | 一套引擎跑所有流程 | **工具通用，技能产物各自独立** |
| LLM 参与 | 意图路由 + 参数抽取 + 录制辅助 | **主脑：意图路由 / 录制分析 / 失败自愈 / 无技能探索**（见 §8）|
| 开发环境 | 内网 | **公网开发 + 自建 Mock 环境，内网只做验证** |
| 周期 | 19 周 | **7 周** |

### 需要澄清的一点

> "每个业务流程都是独立的录制器"

准确说是：**录制器只有一个（通用），技能产物有 N 个（各自独立）**。

```
        ┌──────────────┐
        │  录制器（1个） │   ← 通用工具，这是要开发的东西
        └──────┬───────┘
               │ 录一次产出一份
    ┌──────────┼──────────┬──────────┐
    ▼          ▼          ▼          ▼
 请假.yaml  加班.yaml  报销.yaml  出门条.yaml
    ↑          ↑          ↑          ↑
    └──── 各自独立，互不依赖，可单独手工修改 ────┘
               │
        ┌──────▼───────┐
        │  回放器（1个） │   ← 通用执行引擎
        └──────────────┘
```

**不追求跨流程复用的是"技能内容"，不是"工具本身"。** 如果录制器也做成每个流程一份，Demo 就没有可迭代性了。

---

## 1. 核心设计：混合模式（Hybrid Mode）

### 1.1 两种通道

| 通道 | 机制 | 优势 | 局限 |
|---|---|---|---|
| **Network 通道** | 直接重放 HTTP 请求 | 毫秒级、零 token、100% 确定 | 需处理 CSRF/联动/会话；纯前端交互无对应请求 |
| **UI 通道** | 操作 DOM 元素 | 覆盖一切用户能做的事 | 慢、受渲染时序影响、需稳定定位 |

### 1.2 混合的粒度：**步骤级，不是技能级**

❌ **错误理解**：整个技能要么全走 HTTP，要么全走 UI，失败了整体降级。

✅ **正确设计**：**每一步独立选择通道**。一个技能天然就是混搭的。

以"提交加班申请"为例：

```
步骤1  导航到加班页面           → network (GET) 或 ui(navigate)
步骤2  选择"加班类型=工作日加班"  → ⚠️ 必须 UI 或 显式补调联动接口
         └─ 副作用：触发 POST /overtime/getApprover 返回审批人
步骤3  填开始/结束时间           → merged（表单字段，无独立请求）
步骤4  填事由                   → merged
步骤5  点击提交                 → network (POST /overtime/submit)
```

**步骤 2 是关键**：它不只是"填一个字段"，它触发了联动请求，产出了后续步骤依赖的 `approverId`。

处理方式有两种，录制器要能识别并让人选：
- **方案 A**：这一步走 UI（点击 select，让页面自己发联动请求，再从页面读回 approverId）
- **方案 B**：这一步用 network，但**显式补一次 `getApprover` 调用**，把结果注入变量

Demo 优先做方案 B（快且稳），方案 A 作为降级。

### 1.3 三种 channel 取值

| channel | 含义 |
|---|---|
| `network` | 发 HTTP 请求 |
| `ui` | 操作 DOM |
| `merged` | 不单独执行，值被后续 network 步骤引用 |
| `auto` | 先试 network，失败降级 ui |

---

## 2. 测试环境（Mock OA）

**Mock 环境的质量直接决定 Demo 的可信度**——如果 mock 太干净，公网跑通到内网必崩。

### 2.1 设计原则：必须复刻痛点

| # | 必须复现的坑 | 内网真实场景 | Mock 实现 |
|---|---|---|---|
| K1 | `el-select` 面板 `append-to-body` | 选项渲染在 `<body>` 末尾 | 默认行为即是，不要关掉 |
| K2 | `el-date-picker` 面板挂 body + 格式化 | 日期控件点不中 | 标准 date-picker，禁用直接输入 |
| K3 | `el-dialog` 遮罩动画期间拦截点击 | 弹窗按钮点了没反应 | 保留默认 300ms 动画 |
| K4 | scoped CSS 哈希属性 | `data-v-7f3a9c2e` 每次 build 变 | Vue SFC scoped style |
| K5 | CSS Modules 哈希 class | `_submitBtn_1x9km_12` | 部分组件用 `<style module>` |
| K6 | **字段联动异步请求** | 选类型→带出审批人 | `POST /api/overtime/approver` |
| K7 | CSRF Token | 提交必须带 token | meta 标签 + 请求头校验 |
| K8 | Session Cookie 登录态 | SSO 后的会话 | express-session |
| K9 | 表格虚拟滚动 | 目标行不在 DOM | 历史记录页用 `el-table-v2` |
| K10 | 异步渲染时序 | 骨架先出，数据后到 | 接口人为延迟 300–800ms |
| K11 | Legacy SSR 页面 | JSP/ASP.NET 老系统 | 纯 SSR 页带 `__VIEWSTATE` |
| K12 | **登录态过期** | 会话超时被踢回登录页 | 提供 `/api/_debug/expire` 强制过期，用于测登录握手 |

> **K4/K5 特别说明**：要在构建配置里让哈希**每次 build 都变**（关掉确定性 hash），才能验证"重新构建后技能是否还能回放"。
>
> **K12 是 v3.1 新增**：登录握手逻辑（§7.4）必须能测，否则内网现场才发现有 bug。

### 2.2 技术栈

```
mock-oa/
├── frontend/                 # Vue 3 + Element Plus + Vite
│   ├── src/views/
│   │   ├── Login.vue
│   │   ├── Home.vue
│   │   ├── LeaveApply.vue         # 请假（含 K1 K2 K3）
│   │   ├── OvertimeApply.vue      # 加班（含 K6 联动）
│   │   └── History.vue            # 历史（含 K9 虚拟滚动）
│   └── vite.config.ts             # 关闭确定性 hash
├── frontend-vue2/            # Vue2 + Element UI 2.x 版加班页（迁移风险验证）
├── backend/                  # Express + express-session
│   ├── routes/{auth,leave,overtime,legacy,_debug}.js
│   └── middleware/csrf.js
└── docker-compose.yml
```

### 2.3 关键接口

```
POST /api/login                 { username, password } → 种 session cookie
GET  /api/session               → { loggedIn, user }          # 登录态探测
GET  /api/csrf                  → { token }（也注入页面 meta）
POST /api/_debug/expire         → 强制会话过期（K12，仅 mock）

GET  /api/overtime/types        → [{value:'workday',label:'工作日加班'}, ...]
POST /api/overtime/approver     { type } → { approverId, approverName }   ⚠️ K6
POST /api/overtime/submit       { type,startTime,endTime,reason,approverId,_csrf }
                                → { code:0, no:'OT-...' }

GET  /api/leave/types           → [...]
POST /api/leave/balance         { type } → { remainDays }      ⚠️ 另一个联动
POST /api/leave/submit          { ... } → { code:0, no:'LV-...' }

GET  /legacy/overtime           → SSR HTML，含 __VIEWSTATE / __TOKEN
POST /legacy/overtime/submit    → form-urlencoded
```

### 2.4 关键前端代码（复刻坑点）

```vue
<!-- OvertimeApply.vue —— 复刻 K1/K3/K5/K6/K10 -->
<template>
  <el-form ref="formRef" :model="form" label-width="120px">
    <el-form-item label="加班类型">
      <el-select v-model="form.type" @change="loadApprover" placeholder="请选择">
        <el-option v-for="t in types" :key="t.value"
                   :label="t.label" :value="t.value" />
      </el-select>
    </el-form-item>

    <el-form-item label="开始时间">
      <el-date-picker v-model="form.startTime" type="datetime"
                      :editable="false" format="YYYY-MM-DD HH:mm"
                      value-format="YYYY-MM-DD HH:mm" />
    </el-form-item>

    <el-form-item label="事由">
      <el-input v-model="form.reason" type="textarea" :rows="3" />
    </el-form-item>

    <el-form-item label="审批人">
      <span v-loading="loadingApprover">{{ form.approverName || '—' }}</span>
    </el-form-item>

    <el-form-item>
      <div :class="$style.submitBtn" role="button" @click="openConfirm">提交</div>
    </el-form-item>
  </el-form>

  <el-dialog v-model="confirmVisible" title="确认提交" width="420px">
    <p>确认提交该加班申请？</p>
    <template #footer>
      <el-button @click="confirmVisible = false">取消</el-button>
      <el-button type="primary" @click="doSubmit">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup>
async function loadApprover() {
  loadingApprover.value = true
  await sleep(500)                                  // K10
  const r = await api.post('/api/overtime/approver', { type: form.type })
  form.approverId = r.approverId
  form.approverName = r.approverName
  loadingApprover.value = false
}
</script>

<style module>
.submitBtn { /* CSS Modules → 编译后 class 名带哈希 */ }
</style>
```

```ts
// vite.config.ts —— 让 hash 每次 build 都变
export default defineConfig({
  css: { modules: {
    generateScopedName: `[local]_${Math.random().toString(36).slice(2,8)}_[hash:base64:5]`
  }},
  build: { rollupOptions: { output: {
    entryFileNames: `assets/[name].${Date.now()}.js`
  }}}
})
```

### 2.5 验收：Mock 必须先"能坑住人"

搭好后先做一件事：**用最朴素的 CSS 选择器写一遍自动化，确认它会失败**。

```js
// 这段代码必须失败，否则 mock 不合格
await page.click('.el-select');
await page.click('.el-select .el-option:has-text("工作日加班")');  // ❌ 面板在 body
await page.click('._submitBtn_1x9km_12');                          // ❌ 重新 build 后失效
```

---

## 3. 基于 Playwright 的二次重构

### 3.1 复用什么，改造什么

| Playwright 能力 | Demo 中的用法 | 是否改造 |
|---|---|---|
| `chromium.launchPersistentContext` | 保存登录态（§7） | 直接用 |
| `page.on('request'/'response')` | 录制网络请求 | 直接用 |
| `context.addInitScript` | 注入录制探针 + 定位器 | 直接用 |
| `getByRole/getByLabel/getByText` | 稳定定位 | 直接用 |
| **`selectorGenerator`**（`packages/injected/src/`） | 生成稳定选择器 | **移植 + 改造**（§3.2）|
| codegen 录制器 | 参考其探针实现 | 参考，不直接用 |
| CDP session（`context.newCDPSession`） | 深度网络控制（§7.2） | 直接用 |

### 3.2 selectorGenerator 的改造点

Playwright 原生生成器已优先 role/label/text、避开哈希 class，但对 Element Plus 需加规则：

```ts
const EL_STRATEGIES = [
  {
    // 表单控件 → 用 el-form-item 的 label 文本
    match: (el) => el.closest('.el-form-item'),
    generate: (el) => {
      const label = el.closest('.el-form-item')
        .querySelector('.el-form-item__label')?.textContent.trim()
        .replace(/[:：*\s]/g, '');
      return { strategy: 'el-form-item', label, kind: detectControlKind(el) };
    }
  },
  {
    // 下拉选项 → 关联到它属于哪个 select
    match: (el) => el.closest('.el-select-dropdown__item'),
    generate: (el) => ({ strategy: 'el-option', text: el.textContent.trim(),
                          ownerLabel: currentOpenSelectLabel() })
  },
  {
    // 弹窗内元素 → 记录弹窗标题作为 scope
    match: (el) => el.closest('.el-dialog'),
    generate: (el) => ({ strategy: 'el-dialog-scoped',
                          dialogTitle: el.closest('.el-dialog')
                            .querySelector('.el-dialog__title')?.textContent.trim(),
                          inner: generateGeneric(el) })
  },
  {
    // 表格行内按钮 → 行内唯一文本定位行，再取按钮
    match: (el) => el.closest('.el-table__row'),
    generate: (el) => ({ strategy: 'el-table-cell',
                          rowAnchorText: pickRowAnchor(el.closest('.el-table__row')),
                          buttonText: el.textContent.trim() })
  }
];
```

**核心思想**：不生成 CSS 路径，生成**语义化定位描述**，回放时由定位器解释执行。重新 build、class 变了也不影响。

### 3.3 定位器运行时（`el-locator.js`）

```js
window.__DSH_LOCATOR__ = {

  byFormItem(label, kind) {
    const norm = s => s.trim().replace(/[:：*\s]/g, '');
    const lbl = [...document.querySelectorAll('.el-form-item__label')]
      .find(l => norm(l.textContent) === norm(label));
    if (!lbl) throw new Error(`form-item not found: ${label}`);
    const item = lbl.closest('.el-form-item');
    const map = {
      input: '.el-input__inner', textarea: '.el-textarea__inner',
      select: '.el-select', datepicker: '.el-date-editor input',
      radio: '.el-radio', checkbox: '.el-checkbox'
    };
    const el = item.querySelector(map[kind] || map.input);
    if (!el) throw new Error(`control not found in ${label} (${kind})`);
    return el;
  },

  // 下拉选择（处理 append-to-body）
  async selectOption(label, optionText) {
    const sel = this.byFormItem(label, 'select');
    sel.click();
    const panel = await this.waitFor(() => {
      const ps = [...document.querySelectorAll('.el-select-dropdown')]
        .filter(p => p.style.display !== 'none' &&
                     !p.classList.contains('el-select-dropdown--hidden'));
      return ps[ps.length - 1];
    }, 3000);
    const opt = [...panel.querySelectorAll('.el-select-dropdown__item')]
      .find(o => o.textContent.trim() === optionText);
    if (!opt) throw new Error(`option not found: ${optionText}`);
    opt.click();
    await this.sleep(120);
  },

  // 日期时间（避开面板，直接写值）
  async setDateTime(label, value) {
    const input = this.byFormItem(label, 'datepicker');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype, 'value').set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event('input',  { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown',
      { key: 'Enter', keyCode: 13, bubbles: true }));
    await this.sleep(100);
    document.body.click();
  },

  // 弹窗内定位（等动画结束）
  async inDialog(title, fn) {
    const dlg = await this.waitFor(() =>
      [...document.querySelectorAll('.el-dialog')]
        .find(d => d.querySelector('.el-dialog__title')?.textContent.trim() === title
                && getComputedStyle(d).opacity === '1'), 5000);
    await this.sleep(200);           // 遮罩动画余量，K3
    return fn(dlg);
  },

  tableRowButton(rowAnchorText, buttonText) {
    const row = [...document.querySelectorAll('.el-table__row')]
      .find(r => r.textContent.includes(rowAnchorText));
    if (!row) throw new Error(`row not found: ${rowAnchorText}`);
    const btn = [...row.querySelectorAll('button, .el-button, [role=button]')]
      .find(b => b.textContent.trim() === buttonText);
    if (!btn) throw new Error(`button not found in row: ${buttonText}`);
    return btn;
  },

  sleep: ms => new Promise(r => setTimeout(r, ms)),
  async waitFor(fn, timeout = 5000, interval = 80) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      try { const v = fn(); if (v) return v; } catch (e) {}
      await this.sleep(interval);
    }
    throw new Error('waitFor timeout');
  }
};
```

---

## 4. 录制器设计

### 4.1 架构

```
┌──────────────────────────────────────────────┐
│  Playwright launchPersistentContext           │
│   channel:'chrome'  headless:false            │
│                                               │
│   ┌────────────────────────────────────────┐ │
│   │ addInitScript 注入：                     │ │
│   │  · el-locator.js                        │ │
│   │  · recorder-probe.js                    │ │
│   └────────────────────────────────────────┘ │
│                                               │
│   page.on('request'/'response')  ← 网络录制    │
└───────────────────┬───────────────────────────┘
                    │
          ┌─────────▼──────────┐
          │  录制会话（Node）    │
          │  UI 动作流 + 网络流  │
          │  时间戳对齐          │
          └─────────┬──────────┘
                    │ 结束录制
          ┌─────────▼──────────┐
          │  分析器（规则）      │
          │  噪音过滤 / 关联     │
          │  依赖识别 / 参数候选 │
          └─────────┬──────────┘
                    │
          ┌─────────▼──────────┐
          │  LLM 标注（离线）    │  ← §8.3
          │  命名 / 描述 / 断言建议│
          └─────────┬──────────┘
                    ▼
        ┌──────────────────────────┐
        │  skill.draft.yaml         │  ← 带 TODO 标记
        └───────────┬──────────────┘
                    │ 【人工修正】← Demo 的关键环节
                    ▼
        ┌──────────────────────────┐
        │  skill.yaml               │
        └───────────┬──────────────┘
                    ▼
              回放器执行
```

### 4.2 UI 探针

```js
// recorder-probe.js
(function () {
  let openSelectLabel = null;

  function emit(action) { window.__DSH_RECORD__({ ...action, ts: Date.now() }); }

  document.addEventListener('click', e => {
    const el = e.target;

    const selWrap = el.closest('.el-select');
    if (selWrap) {
      openSelectLabel = selWrap.closest('.el-form-item')
        ?.querySelector('.el-form-item__label')?.textContent.trim();
      return;                       // select 本身的点击不单独记录
    }

    const opt = el.closest('.el-select-dropdown__item');
    if (opt) {
      emit({ type: 'select', label: openSelectLabel, value: opt.textContent.trim() });
      openSelectLabel = null;
      return;
    }

    emit({ type: 'click', target: window.__DSH_GEN__(el),
           text: el.textContent.trim().slice(0, 30) });
  }, true);

  document.addEventListener('change', e => {
    const el = e.target;
    if (!['INPUT','TEXTAREA','SELECT'].includes(el.tagName)) return;
    if (el.closest('.el-date-editor'))
      emit({ type: 'datetime', target: window.__DSH_GEN__(el), value: el.value });
    else
      emit({ type: 'fill', target: window.__DSH_GEN__(el), value: el.value });
  }, true);
})();
```

### 4.3 网络录制

```js
const NOISE = [
  /\.(js|css|png|jpg|svg|woff2?|ico|map)(\?|$)/i,
  /\/(heartbeat|ping|track|collect|analytics|log)/i,
];

page.on('response', async (res) => {
  const req = res.request();
  const url = req.url();
  if (NOISE.some(r => r.test(url))) return;
  if (!['xhr','fetch'].includes(req.resourceType()) && req.method() === 'GET') return;

  session.network.push({
    ts: Date.now(), method: req.method(), url,
    headers: req.headers(), postData: req.postData(),
    status: res.status(), body: await res.text().catch(() => null),
    mutating: req.method() !== 'GET'
  });
});
```

### 4.4 动作-请求关联（规则，不需要 LLM）

1. **时间窗关联**：请求发生在某 UI 动作后 0–2000ms 内 → 归属该动作
2. **副作用标记**：动作后有 `mutating` 请求 → `hasSideEffect: true`
3. **依赖识别**：请求 B 的参数值出现在请求 A 的响应中 → `B depends on A`
4. **终态识别**：最后一个 mutating 请求 → 候选 `submitStep`

### 4.5 草稿产物示例

```yaml
# skill.draft.yaml —— 录制器生成，请人工检查所有 TODO
skill:
  id: "oa_overtime_submit"
  name: "提交加班申请"
  system: "mock-oa"
  baseUrl: "http://localhost:5173"
  recordedAt: "2026-08-17T14:32:00+08:00"

auth:                                # §7.4 登录握手配置
  probeUrl: "/overtime/apply"
  sessionApi: "/api/session"
  loggedInJsonPath: "$.loggedIn"
  loginUrlPattern: "/login"

params:
  - { name: type,      type: enum,     values: [工作日加班, 周末加班, 节假日加班] }
  - { name: startTime, type: datetime, format: "YYYY-MM-DD HH:mm" }
  - { name: endTime,   type: datetime, format: "YYYY-MM-DD HH:mm" }
  - { name: reason,    type: string }

steps:
  - id: s1
    desc: "打开加班申请页"
    channel: network
    network: { method: GET, url: "/overtime/apply" }
    ui:      { action: navigate, url: "/overtime/apply" }

  - id: s2
    desc: "选择加班类型"
    # ⚠️ 检测到此动作触发 mutating 请求，其响应被 s5 使用
    hasSideEffect: true
    channel: network                 # TODO: network 失败时改 ui
    network:
      method: POST
      url: "/api/overtime/approver"
      body: { type: "{{type|enumValue}}" }
      extract: { approverId: "$.approverId" }
    ui:
      action: selectOption
      label: "加班类型"
      value: "{{type}}"
      waitFor: { selector: ".el-form-item:has-text('审批人') span", notEmpty: true }

  - id: s3
    desc: "填写开始时间"
    channel: merged
    ui: { action: setDateTime, label: "开始时间", value: "{{startTime}}" }

  - id: s4
    desc: "填写事由"
    channel: merged
    ui: { action: fill, label: "事由", kind: textarea, value: "{{reason}}" }

  - id: s5
    desc: "提交"
    channel: network
    riskLevel: write                 # 执行前需确认
    network:
      method: POST
      url: "/api/overtime/submit"
      headers: { X-CSRF-TOKEN: "{{csrf}}" }
      contentType: json
      body:
        type: "{{type|enumValue}}"
        startTime: "{{startTime}}"
        endTime: "{{endTime}}"
        reason: "{{reason}}"
        approverId: "{{s2.approverId}}"
    ui:
      action: click
      strategy: el-dialog-scoped
      dialogTitle: "确认提交"
      buttonText: "确定"
      preAction: { action: click, strategy: css-module, text: "提交" }

preflight:
  - { name: csrf, source: "meta[name=csrf-token]@content" }

assertions:
  - { type: httpStatus, expect: 200 }
  - { type: jsonPath, path: "$.code", expect: 0 }
  - { type: extract, name: bizNo, path: "$.no" }

_notes:
  - "s2 响应 approverId=1023 出现在 s5 请求体中，已自动建立依赖"
  - "共捕获 14 个请求，过滤 11 个静态/心跳，保留 3 个"
  - "检测到 el-select 使用 append-to-body，UI 通道采用 selectOption 策略"
  - "s3/s4 未触发请求，标记 channel=merged"
```

### 4.6 人工修正是设计的一部分

- 草稿里所有不确定处打 `# TODO`
- `_notes` 写清楚"为什么这么判断"
- `dsh replay skill.yaml --params p.json --dry-run` 快速验证
- `dsh diff <rec1> <rec2>` 对比两次录制，识别哪些值是变量

---

## 5. 回放器设计

### 5.1 执行策略

```
对每个 step：
  ├─ merged  → 只收集值，不执行
  ├─ network → 发 HTTP 请求
  │     ├─ 成功 + 断言通过 → 下一步
  │     └─ 失败 → 若配置了 ui，降级重试一次
  ├─ ui      → 调 el-locator 执行
  │     ├─ 成功 → 下一步
  │     └─ 失败 → 【触发 LLM 自愈，§8.4】
  │                 自愈成功 → 写回 YAML → 继续
  │                 自愈失败 → 诊断包 + 中止
  └─ auto    → 先 network，失败降级 ui
```

### 5.2 混合执行必须共用会话

**关键点**：network 通道和 ui 通道**必须共用同一浏览器会话**，否则 Cookie/CSRF 对不上。所以 network 步骤也在页面上下文里发：

```js
async function execNetworkStep(page, step, ctx) {
  return await page.evaluate(async ({ method, url, headers, body, contentType }) => {
    const res = await fetch(url, {
      method,
      credentials: 'include',
      headers: {
        'Content-Type': contentType === 'json'
          ? 'application/json' : 'application/x-www-form-urlencoded',
        ...headers
      },
      body: contentType === 'json'
        ? JSON.stringify(body) : new URLSearchParams(body).toString()
    });
    return { status: res.status, text: await res.text() };
  }, resolveTemplate(step.network, ctx));
}
```

这同时解决三件事：Cookie 自动带、同源无 CORS、内网迁移行为一致。**这就是 v2 里"页面内同源执行"的落地。**

### 5.3 诊断包

```
runs/2026-08-17T14-40-12/
├── result.json          # 每步状态、耗时、通道、LLM 介入记录
├── step-s2-before.png
├── step-s2-after.png
├── step-s2-dom.html     # 失败时 DOM 快照
├── step-s2-snapshot.txt # 喂给 LLM 的压缩快照（便于复盘 LLM 判断）
├── llm-trace.jsonl      # 每次 LLM 调用的输入输出
├── network.har
└── console.log
```

---

## 6. 公网开发 → 内网迁移

| 差异点 | 公网 mock | 内网真实 | 迁移动作 |
|---|---|---|---|
| 登录方式 | 表单登录 | SSO / AD 域集成认证 | 见 §7.3 分类处理 |
| CSRF | meta 标签 | 可能 Cookie-to-Header、可能没有 | 录制器自动检测，看 preflight |
| Element 版本 | Element Plus | 可能 Element UI 2.x (Vue2) | el-locator 加版本适配层 |
| 页面加载速度 | 本地毫秒级 | 内网可能几秒 | 所有 timeout 参数化 |
| 接口路径 | `/api/...` | 各系统各异 | baseUrl + path 可配 |
| 浏览器版本 | 最新 Chrome | 可能老版本/国产浏览器 | 提前确认，见 §7.5 |
| 代理 | 无 | 内网代理 / PAC | Playwright `proxy` 配置 |
| 模型 | 公网 DeepSeek API | 内网 DeepSeek，无视觉 | 接口抽象，见 §8.2 |

**迁移验证顺序**：先只跑 UI 通道 → 再录一遍真实接口 → 再启用 network 通道。

> ⚠️ 内网 OA 若是几年前项目，大概率 **Vue2 + Element UI 2.x**。类名主体相同（`el-form-item__label`、`el-select-dropdown__item` 都在），但 `el-dialog` 结构、`append-to-body` 默认值有出入。**建议 mock 同时做 Vue2 版页面**，成本一天，省掉迁移期返工。

---

## 7. 运行时载体与认证方案 【v3.1 新增】

### 7.1 载体选型结论

**结论：Playwright 驱动系统安装的真实 Chrome（`channel: 'chrome'`），不用扩展形态，不用第三方内核浏览器。**

| 能力 | Chrome 扩展 (MV3) | **Playwright + 真实 Chrome** | 指纹浏览器 |
|---|---|---|---|
| 读写请求 body | ❌ `declarativeNetRequest` 读不到 body | ✅ CDP Network/Fetch 全量 | ✅ |
| 拦截/暂停/改写请求 | ⚠️ 受限 | ✅ `Fetch.requestPaused` | ✅ |
| document_start 注入 MAIN world | ⚠️ 需绕 | ✅ `addInitScript` | ✅ |
| 浏览器级弹窗（证书选择、Basic Auth、下载） | ❌ 够不着 | ✅ | ✅ |
| 后台脚本存活 | ❌ SW 30 秒被杀，长流程会断 | ✅ Node 进程 | ✅ |
| 用户手动接管 | ✅ | ✅ 同一窗口直接操作 | ✅ |
| 企业证书链 / 域策略继承 | ✅ | ✅（用系统 Chrome） | ❌ |
| 安全审查通过率 | 中 | **高**（微软官方开源工具） | ❌ 低 |

**你担心"扩展控制力不足"是对的**——MV3 在网络层和 Service Worker 生命周期上确实有硬限制。但结论不是转向第三方内核，而是用 CDP。

### 7.2 为什么排除指纹浏览器

CloakBrowser / AdsPower / BitBrowser 这类工具解决的是**指纹伪装、多账号隔离、反爬对抗**。

你的环境：内网、无机器验证、无验证码、无短信验证。**它能解决的问题一个都不存在**，而带来的问题一堆：

- 闭源，安全审查无法通过
- 多数需联网授权/激活，内网环境不适用
- 内核版本通常落后于主线 Chrome
- 无法继承企业根证书和 Chrome Enterprise Policy
- 出问题无法向微软/Google 社区求助

**明确排除。**

### 7.3 三类认证的处理方式

内网验证时**第一件事就是确认属于哪一类**。

#### 类型 A：AD 域集成认证（Kerberos / NTLM）—— 零交互

内网 OA 相当常见。浏览器用当前 Windows 登录票据自动协商，**全程无人工**：

```js
const ctx = await chromium.launchPersistentContext('./profile-oa', {
  channel: 'chrome',              // 系统真实 Chrome，继承企业策略与证书
  headless: false,
  args: [
    '--auth-server-allowlist=*.corp.local',
    '--auth-negotiate-delegate-allowlist=*.corp.local',
  ]
});
```

**这是最理想情况，优先确认是否适用。**

#### 类型 B：表单登录 / SAML / OAuth 跳转 —— 首次手动，之后免登

```js
const ctx = await chromium.launchPersistentContext('./profile-oa', {
  channel: 'chrome', headless: false
});
// 首次：用户在这个真实 Chrome 窗口里正常输账号密码 / 走 SSO 跳转
// 关闭后 cookie / localStorage 留在 ./profile-oa
```

之后每次启动同一 `user-data-dir`，登录态直接在。SSO 会话通常有效几天到几周，重登频率很低。

**关键认知：Playwright 启动的是真实可见的 Chrome 窗口，用户完全可以手动操作。** 这不是"无头自动化里塞不进人工"的问题——窗口就在那儿，键盘鼠标随时能用。

#### 类型 C：客户端证书

```js
chromium.launchPersistentContext('./profile-oa', {
  channel: 'chrome',
  clientCertificates: [{
    origin: 'https://oa.corp.local',
    pfxPath: './client.pfx',
    passphrase: process.env.CERT_PASS
  }]
});
```

### 7.4 半自动登录握手（核心逻辑）

回放前探测登录态，掉线就把窗口推到前台请用户登录，登录完自动继续。

```js
async function ensureLoggedIn(page, auth) {
  await page.goto(auth.probeUrl, { waitUntil: 'domcontentloaded' });

  const isLoggedIn = async () => {
    // 优先用接口探测（比 DOM 可靠）
    if (auth.sessionApi) {
      const r = await page.evaluate(async (u) => {
        try {
          const res = await fetch(u, { credentials: 'include' });
          return { status: res.status, text: await res.text() };
        } catch (e) { return { status: 0, text: '' }; }
      }, auth.sessionApi);
      if (r.status === 401 || r.status === 403) return false;
      try { return !!JSON.parse(r.text).loggedIn; } catch { return r.status === 200; }
    }
    // 退化：看是否被重定向到登录页
    return !new RegExp(auth.loginUrlPattern).test(page.url());
  };

  if (await isLoggedIn()) return;

  await page.bringToFront();
  await page.evaluate(() => {
    const b = document.createElement('div');
    b.id = '__dsh_login_hint__';
    b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;'
      + 'background:#409eff;color:#fff;padding:12px;text-align:center;'
      + 'font-size:15px;font-family:sans-serif';
    b.textContent = 'DSH 需要登录：请在本窗口完成登录，登录成功后将自动继续';
    document.body.appendChild(b);
  });

  const deadline = Date.now() + (auth.loginTimeoutMs || 5 * 60 * 1000);
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    if (await isLoggedIn().catch(() => false)) {
      await page.evaluate(() =>
        document.getElementById('__dsh_login_hint__')?.remove());
      return;
    }
  }
  throw new Error('LOGIN_TIMEOUT');
}
```

**同样的握手也用在"回放中途会话过期"**：任一步骤返回 401/403 或被重定向到登录页 → 暂停 → 调用 `ensureLoggedIn` → 从当前步骤重试。

**凭证从头到尾只在用户与浏览器之间，DSH 不接触、不存储。** 这也正是 v2 里确立的合规立足点。

### 7.5 内网现场需确认的载体清单

- [ ] Chrome 版本（Playwright `channel:'chrome'` 需 Chrome 已安装）
- [ ] 是否强制使用国产浏览器（若是 Chromium 内核可用 `executablePath` 指定；若是 IE 内核则 Playwright 不支持，需另议）
- [ ] Chrome Enterprise Policy 是否禁用了 `--remote-debugging`（部分企业策略会封）
- [ ] 认证类型属于 A / B / C 哪一类
- [ ] 是否需要走内网代理 / PAC
- [ ] 是否有强制的浏览器安全插件会干扰自动化

---

## 8. LLM 接入设计 【v3.1 新增，推翻 v3 结论】

v3 曾建议 Demo 不接 LLM。**这个结论改掉**——LLM 是主脑，但必须放在对的位置。

**核心原则：LLM 做决策，不做执行。**

### 8.1 双速模型

```
             ┌─────────────────────┐
用户输入 ───▶│ LLM：意图 → 技能 + 参数 │
             └──────────┬──────────┘
                        ▼
                  有匹配技能？
           ┌────是────┴────否────┐
           ▼                      ▼
     ┌──────────────┐      ┌──────────────────┐
     │  快通道       │      │  慢通道           │
     │  YAML 确定性回放│      │  LLM 探索循环     │
     │  零 LLM 参与   │      │  受限动作空间     │
     └──────┬───────┘      └────────┬─────────┘
            │ 某步失败                │ 成功
            ▼                        ▼
     ┌──────────────┐        ┌──────────────┐
     │ LLM 自愈      │        │ 固化为新技能  │
     │ 看压缩DOM     │        │ 写 skill.yaml│
     │ → 提定位方案  │        └──────────────┘
     │ → 【验证】    │
     │ → 写回 YAML   │
     └──────────────┘
```

### 8.2 LLM 的四个职责

| # | 职责 | 时机 | 风险 | 价值 |
|---|---|---|---|---|
| J1 | 意图路由 + 参数抽取 | 运行时 | 低 | 用户能说人话 |
| J2 | 录制后分析标注 | 离线 | 无 | 参数命名、依赖推断、断言建议 |
| J3 | **失败自愈** ⭐ | 运行时 | 中 | 提定位方案，**必须验证通过才写回** |
| J4 | 无技能时探索 | 运行时 | 高 | 慢通道兜底，成功后固化 |

**模型接口抽象**（公网/内网切换）：

```ts
interface ILLMProvider {
  name: string;                      // 'deepseek-public' | 'deepseek-intranet'
  chat(messages: Msg[], opts?: { jsonSchema?: object }): Promise<string>;
  supportsVision: boolean;           // 内网为 false，全链路不得依赖视觉
}
```

Demo 开发期用公网 DeepSeek API，内网切换只改配置。**任何设计都不得假设 `supportsVision === true`。**

### 8.3 J2：录制后 LLM 标注（离线，最安全）

分析器出规则结果后，把结构化摘要交给 LLM 做人类可读的加工：

```
输入：
  UI 动作序列 + 保留的网络请求 + 规则分析结果（依赖关系、参数候选）
输出（JSON）：
  - 技能 id / name / description 建议
  - 每个 step 的 desc
  - 参数命名、类型、是否必填
  - 断言建议（从响应结构推断成功判据）
  - 风险提示（哪些步骤看起来是写操作）
```

**离线执行，产物进 draft.yaml 且全部打 `# TODO`，人工定稿。** 错了也不会造成任何执行后果。

### 8.4 J3：失败自愈（LLM 最值钱的地方）

```
快通道 s4 失败：byFormItem('事由','textarea') 找不到
   ↓
抓当前页面压缩快照（§8.6）
   ↓
喂给 LLM：
   「原定位：{ strategy:'el-form-item', label:'事由', kind:'textarea' }
     执行失败：form-item not found: 事由
     步骤目标：填写加班事由
     当前页面：<压缩快照>
     请给出新的定位描述（只能用已定义的 strategy）」
   ↓
LLM 返回：{ strategy:'el-form-item', label:'加班原因', kind:'textarea' }
   ↓
【必须先验证】用新定位试执行
   ├─ 成功 → 写回 skill.yaml，version+1，
   │          记录 { healedAt, healedBy:'llm', oldTarget, newTarget }
   │          → 继续后续步骤
   └─ 失败 → 最多重试 2 次 → 仍失败则产出诊断包中止
```

**"验证通过才写回"是硬约束。** 没有这一环，自愈就是在往技能库里写垃圾，而且会静默污染——比直接失败更糟。

自愈变更要留痕并可回滚：

```yaml
_healHistory:
  - at: "2026-08-17T15:02:11+08:00"
    step: s4
    reason: "form-item not found: 事由"
    old: { strategy: el-form-item, label: 事由, kind: textarea }
    new: { strategy: el-form-item, label: 加班原因, kind: textarea }
    verified: true
    model: "deepseek-chat"
```

### 8.5 J4：受限动作空间（无技能时的探索）

DeepSeek 无视觉，感知输入必须是文本。给它压缩语义快照，让它**从固定动作集里选**，不让它自由生成选择器：

```
你正在操作：OA 加班申请页
任务：提交一条工作日加班，18:00-21:00，事由"版本上线"

当前页面元素：
[1] select   "加班类型"   值:(空)  可选: 工作日加班/周末加班/节假日加班
[2] input    "开始时间"   值:(空)  类型: datetime
[3] input    "结束时间"   值:(空)  类型: datetime
[4] textarea "事由"       值:(空)
[5] text     "审批人"     值: —
[6] button   "提交"

可用动作（只能用这些）：
  selectOption(idx, value)
  fill(idx, value)
  setDateTime(idx, value)
  click(idx)
  waitFor(idx, condition)      # condition: notEmpty | visible | enabled
  readValue(idx)
  done(summary)
  fail(reason)

输出严格 JSON，一次一个动作：{"action":"...","idx":N,"value":"..."}
```

**三重校验，缺一不可**：
1. JSON Schema 校验（动作名在白名单内）
2. 索引存在性校验（`idx` 必须在当前快照中）
3. 值合法性校验（enum 类型必须是给出的可选值之一）

任一不过 → 打回重试，最多 3 次 → 转失败。

**这样即使 LLM 胡说，也只能在合法动作里胡说，不会产生不可控操作。**

### 8.6 压缩快照生成器（无视觉的替代品）

这是 LLM 的"眼睛"，质量决定一切。生成规则：

- 只保留可见且可交互的元素
- **优先用 `el-form-item` 的 label 作为元素名**（比 aria-label 更贴合业务）
- 剔除纯布局 div、装饰性图标
- 表格合并：只输出表头 + 前 N 行 + "…共 M 行"
- 附带当前值和控件类型（LLM 才知道该用 fill 还是 setDateTime）
- 弹窗打开时**只输出弹窗内元素**并标注 `[对话框: 确认提交]`
- 目标：**单页 < 2000 token**

```js
function buildSnapshot(doc) {
  const dialog = [...doc.querySelectorAll('.el-dialog')]
    .find(d => getComputedStyle(d).opacity === '1');
  const root = dialog || doc;
  const prefix = dialog
    ? `[对话框: ${dialog.querySelector('.el-dialog__title')?.textContent.trim()}]\n`
    : '';
  // ... 遍历 el-form-item / button / table，输出编号列表
  return prefix + lines.join('\n');
}
```

### 8.7 护栏（不可因"LLM 很聪明"而放松）

| 场景 | 护栏 |
|---|---|
| `riskLevel: write` 步骤 | **一律停下等人确认**，快通道慢通道都一样 |
| LLM 自愈 | 必须验证通过才写回；变更留痕可回滚 |
| LLM 探索 | 受限动作空间 + 三重校验 + 最多 N 步（建议 20）|
| Token 预算 | 单次任务上限，超出熔断 |
| 参数抽取 | 结果必须过参数 Schema 校验；缺失参数反问用户，**不允许 LLM 自行编造** |
| 全链路 | 每次 LLM 调用输入输出写 `llm-trace.jsonl`，可复盘 |

### 8.8 成本与性能预期

| 路径 | LLM 调用次数 | 延迟 | 说明 |
|---|---|---|---|
| 快通道（技能命中，全 network） | 1（意图路由） | < 3 秒 | 生产常态 |
| 快通道 + 一次自愈 | 2–3 | 5–10 秒 | 偶发 |
| 慢通道探索（10 步） | 11+ | 60–120 秒 | 仅首次 |

**这就是"双速"的意义**：探索一次贵，固化之后近乎免费。

---

## 9. Demo 边界（明确不做什么）

为 7 周交付，以下明确排除：

- ❌ Web 管理界面 / 技能市场（用 CLI + 文件）
- ❌ 自动参数化（给候选，人工定）
- ❌ 元素指纹多特征打分（用语义定位策略即可）
- ❌ 多用户 / 权限 / 审计后台（只留本地日志）
- ❌ 视觉 grounding（无 VL 模型，也不需要）
- ❌ 跨技能工作流编排
- ❌ 浏览器扩展形态（用 Playwright 独立进程，见 §7.1）
- ❌ 无人值守定时执行（登录态依赖用户，见 §7.4）

**这些不是砍掉，是排到 Demo 之后。** v2 的平台设计仍然有效，Demo 验证的是它的地基。

---

## 10. 验收标准

| # | 验收项 | 判定 |
|---|---|---|
| A1 | 在 mock OA 上录制"提交加班申请"全流程 | 产出 draft.yaml |
| A2 | 人工修正后回放成功 | 连续 10 次成功 ≥ 9 次 |
| A3 | **前端重新 build（class hash 全变）后同一技能仍能回放** | ✅ **最核心** |
| A4 | 录制"提交请假申请"，复用同一录制器无需改代码 | 证明录制器通用 |
| A5 | network 通道跑通加班提交 | 单次 < 2 秒 |
| A6 | 手动破坏一步（改按钮文案）→ **LLM 自愈成功并写回 YAML** | 自愈闭环有效 |
| A7 | Legacy SSR 页（含 `__VIEWSTATE`）录制回放 | 老系统路径 |
| A8 | Vue2 + Element UI 版页面同样可录可放 | 降低迁移风险 |
| **A9** | **自然语言输入 → 意图路由 → 参数抽取 → 执行** | LLM 主脑链路 |
| **A10** | **无技能时慢通道探索成功并固化为新技能** | 探索闭环 |
| **A11** | **会话过期（K12）→ 登录握手 → 自动继续** | §7.4 有效 |
| **A12** | **LLM 输出非法动作 → 被校验拦截并重试** | 护栏有效 |

**A3 和 A6 是最重要的两条**：一条回答"build 后会不会崩"，一条回答"崩了能不能自己修"。

---

## 11. 路线图（7 周）

| 周 | 内容 | 产出 |
|---|---|---|
| **W1** | Mock OA（Vue3+Element Plus，请假/加班/历史）+ K1–K12 坑点 | 环境 + 朴素选择器失败验证 |
| **W2** | `el-locator.js` + 手写脚本跑通加班流程 | 定位策略有效（不含录制器）|
| **W3** | 浏览器载体与认证：persistent context、登录握手、会话过期恢复 | §7 全部落地 |
| **W4** | 录制器：UI 探针 + 网络录制 + 选择器生成器 | 原始录制 JSON |
| **W5** | 分析器（规则）+ LLM 标注（J2）→ draft.yaml | 草稿生成 |
| **W6** | 回放器：混合通道、模板引擎、断言、诊断包 | 端到端确定性回放 |
| **W7** | LLM 主脑：意图路由(J1)、自愈(J3)、探索(J4)、压缩快照、护栏 | Demo 交付 |

补充项穿插进行：Vue2 版页面、Legacy SSR 页、验收自动化。

**内网验证（W8–W9，需现场配合）**：载体清单确认（§7.5）→ 认证类型判定 → 迁移清单逐项对照 → 真实 OA 录制 → 问题清单 → 决定是否进入框架阶段。

---

## 12. 任务清单（给 GPT / 编码助手）

### M · Mock 环境
- **M1** Vue3 + Element Plus + Vite 骨架：登录/首页/请假/加班/历史
- **M2** 复刻坑点 K1–K12，重点 K6 联动、K3 弹窗动画、K12 会话过期
- **M3** Vite 配置：CSS Modules 哈希每次 build 变化
- **M4** Express 后端 + session + CSRF + 全部接口（§2.3）
- **M5** Legacy SSR 页（`__VIEWSTATE` + form POST）
- **M6** Vue2 + Element UI 2.x 版加班页
- **M7** 反向验证脚本：朴素 CSS 选择器操作，确认会失败
- **M8** docker-compose 一键启动

### L · 定位器
- **L1** `el-locator.js`：byFormItem / selectOption / setDateTime / inDialog / tableRowButton / waitFor
- **L2** Element UI 2.x 兼容层（版本探测 + 类名映射）
- **L3** 手写脚本验证：连续 20 次跑通加班流程

### B · 浏览器载体与认证 【新增】
- **B1** `launchPersistentContext` 封装：channel/proxy/args/clientCertificates 可配
- **B2** Kerberos/NTLM 参数支持（`--auth-server-allowlist`）
- **B3** `ensureLoggedIn` 登录握手（接口探测 + 页面横幅 + 轮询等待）
- **B4** 会话过期检测（401/403/重定向）→ 暂停 → 握手 → 从当前步骤重试
- **B5** CDP session 封装（深度网络控制备用）
- **B6** 内网载体检查脚本（输出 §7.5 清单结果）

### R · 录制器
- **R1** 录制会话管理（开始/暂停/结束、时间戳对齐）
- **R2** `recorder-probe.js` UI 事件探针
- **R3** 选择器生成器：移植 Playwright selectorGenerator + Element 策略（§3.2）
- **R4** 网络录制 + 噪音过滤
- **R5** CLI：`dsh record --url <url> --out <dir>`

### A · 分析器
- **A1** 动作-请求时间窗关联
- **A2** 副作用标记
- **A3** 依赖识别（响应值 → 后续请求参数）
- **A4** 参数候选标注
- **A5** preflight 检测（CSRF / ViewState / 隐藏字段）
- **A6** auth 段自动生成（探测登录接口与登录页 URL 模式）
- **A7** draft.yaml 生成器（含 TODO 与 _notes）

### P · 回放器
- **P1** 技能 YAML Schema + 校验
- **P2** 模板引擎（`{{param}}`、`{{stepId.field}}`、过滤器 `enumValue`/`date:fmt`）
- **P3** network 通道执行器（页面内 fetch，§5.2）
- **P4** ui 通道执行器（调 el-locator）
- **P5** merged 通道处理
- **P6** 降级链 + 重试
- **P7** 断言引擎（httpStatus / jsonPath / textPresent / regex extract）
- **P8** 诊断包生成
- **P9** CLI：`dsh replay <skill.yaml> --params <json> [--dry-run] [--channel ui|network] [--no-llm]`
- **P10** `dsh diff <rec1> <rec2>`

### N · LLM 主脑 【新增】
- **N1** `ILLMProvider` 抽象 + DeepSeek 适配（公网/内网双配置）
- **N2** 压缩快照生成器（§8.6，单页 < 2000 token）
- **N3** J1 意图路由 + 参数抽取（含 Schema 校验、缺失参数反问）
- **N4** J2 录制后标注（离线，产出进 draft.yaml 并打 TODO）
- **N5** J3 失败自愈：提方案 → **验证** → 写回 YAML → `_healHistory` 留痕
- **N6** J4 受限动作空间探索循环 + 三重校验 + 步数上限
- **N7** 探索成功 → 固化为 skill.yaml
- **N8** 护栏：write 步骤强制确认、token 预算熔断、`llm-trace.jsonl`
- **N9** `--no-llm` 开关（纯确定性回放，用于内网排障对照）

### V · 验收
- **V1** A1–A12 验收用例自动化
- **V2** A3 专项：build → 回放 → build → 回放，循环 5 次
- **V3** A6 专项：注入 5 种页面变更，验证自愈成功率
- **V4** 内网迁移清单文档（§6 表 + §7.5 载体清单）

---

## 附录 · 与 v1/v2 的对应关系

| v1/v2 概念 | v3.1 中的状态 |
|---|---|
| L0 真实 API（MCP 薄层） | 暂不涉及（部门不配合，已放弃） |
| L1 接口重放 | **→ network 通道**，Demo 核心 |
| L2 结构化 UI 操作 | **→ ui 通道 + el-locator**，Demo 核心 |
| L3 视觉 grounding | 排除（无 VL 模型，全链路不得依赖） |
| L4 人工接管 | 简化为"诊断包 + 登录握手"，完整 HITL 排到框架阶段 |
| 技能固化 | **→ skill.yaml**，Demo 核心产物 |
| 元素指纹 + 自愈 | 定位用语义策略；**自愈由 LLM 承担（§8.4）** |
| 页面内同源执行 | **→ §5.2 network 通道实现** |
| 浏览器扩展形态 | **明确排除**（§7.1），Playwright + 真实 Chrome |
| 技能平台 / 市场 | 排到 Demo 之后 |
| 双速模型（探索慢/执行快） | **→ §8.1**，Demo 已包含 |

---

**文档结束**
