// DSH 覆盖矩阵摸底 fixture（任务：DSH-覆盖矩阵摸底任务-GLM.md §2）
// 形态铁律：无手写静态 id（label[for] 用运行时生成 id 关联）、自定义 class 全部带 build hash
// （仅保留 element-plus 语义类 el-form-item / el-select / el-date-editor，与真实系统一致）、
// 浮层挂 body、选项渲染保留延迟；后端落库保留原始形态并提供查询/清空接口（§2.4）。
import { createServer, type Server } from 'node:http';

export interface StoredFile {
  field: string;
  filename: string;
  size: number;
  contentType: string;
}

export interface StoredRecord {
  cell: string;
  seq: number;
  ts: number;
  method: string;
  contentType: string;
  raw: string | null;
  parsed: unknown;
  files?: StoredFile[];
  query: string;
}

export interface MatrixServer {
  server: Server;
  baseUrl: string;
  hash: string;
  records: (cell: string) => StoredRecord[];
  clear: (cell: string) => void;
  close: () => Promise<void>;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const CASCADE_REMOTE: Record<string, Array<{ label: string; value: string }>> = {
  l0: [{ label: '江苏省', value: '江苏省' }, { label: '广东省', value: '广东省' }],
  '江苏省.l1': [{ label: '南京市', value: '南京市' }, { label: '苏州市', value: '苏州市' }],
  '广东省.l1': [{ label: '广州市', value: '广州市' }],
  '江苏省|南京市.l2': [{ label: '鼓楼区', value: '鼓楼区' }, { label: '玄武区', value: '玄武区' }],
  '江苏省|苏州市.l2': [{ label: '姑苏区', value: '姑苏区' }],
  '广东省|广州市.l2': [{ label: '天河区', value: '天河区' }],
};

const USERS = [
  { label: '王五', value: 'u3' },
  { label: '王小明', value: 'u4' },
  { label: '李卫东', value: 'u5' },
];

function formItem(label: string | null, inner: string, wire = false): string {
  const labelHtml = label === null
    ? ''
    : `<label class="el-form-item__label"${wire ? ' data-wire="1"' : ''}>${esc(label)}</label>`;
  return `<div class="el-form-item">${labelHtml}<div class="el-form-item__content">${inner}</div></div>`;
}

interface PageContext {
  hash: string;
  fi: typeof formItem;
}

type PageBuilder = (ctx: PageContext) => string;

function shell(cell: string, title: string, hash: string, body: string, script: string): string {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>
body{font:14px/1.6 system-ui,sans-serif;margin:24px;color:#303133}
h2{font-size:16px;margin:0 0 16px}
.el-form-item{display:flex;margin-bottom:18px;align-items:flex-start}
.el-form-item__label{width:110px;text-align:right;padding-right:12px;color:#606266}
.el-form-item__content{flex:1}
input[type=text],input[type=number],textarea,select{border:1px solid #dcdfe6;border-radius:4px;padding:4px 8px;font:inherit}
.panel-${hash}{position:fixed;top:64px;left:48px;background:#fff;border:1px solid #dcdfe6;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,.1);z-index:3000;padding:10px;min-width:160px}
.panel-${hash}[aria-busy=true]{color:#909399}
.opt-${hash}{padding:4px 10px;cursor:pointer;border-radius:3px}
.opt-${hash}:hover{background:#f5f7fa}
.daygrid-${hash}{display:grid;grid-template-columns:repeat(7,30px);gap:2px}
.day-${hash}{border:0;background:#fff;cursor:pointer;padding:4px 0;border-radius:3px;font:inherit}
.day-${hash}:hover{background:#f5f7fa}
.chip-${hash}{display:inline-flex;align-items:center;background:#ecf5ff;color:#409eff;border-radius:3px;padding:2px 6px;margin-right:6px}
.tagx-${hash}{border:0;background:transparent;color:#409eff;cursor:pointer;padding:0 2px}
.tree-${hash} ul{list-style:none;padding-left:18px;margin:4px 0}
.tree-${hash} .node-${hash}{display:flex;gap:6px;align-items:center;margin:2px 0}
.tgl-${hash}{border:0;background:transparent;cursor:pointer;color:#409eff;padding:0;font:inherit}
.switch-${hash}{width:44px;height:22px;border-radius:11px;border:1px solid #dcdfe6;background:#c0c4cc;color:transparent;cursor:pointer}
.switch-${hash}[aria-checked=true]{background:#409eff;border-color:#409eff}
.muted-${hash}{color:#909399;font-size:12px}
</style></head><body>
<h2>${esc(title)}</h2>
<form onsubmit="return false">
${body}
<div class="el-form-item"><div class="el-form-item__content">
<button type="button" class="submit-${hash}">提交</button>
<span class="result-${hash}"></span>
</div></div>
</form>
<script>
var HASH=${JSON.stringify(hash)}, CELL=${JSON.stringify(cell)};
function genId(){return 'f_'+Math.random().toString(36).slice(2,10);}
document.querySelectorAll('label[data-wire]').forEach(function(l){
  var wrap=l.closest('.el-form-item');if(!wrap)return;
  var inp=wrap.querySelector('.el-form-item__content input, .el-form-item__content select, .el-form-item__content textarea');
  if(inp){var id=genId();inp.id=id;l.setAttribute('for',id);}
});
var PANEL_CLS='panel-'+HASH, OPT_CLS='opt-'+HASH;
function closePanel(){var p=document.querySelector('.'+PANEL_CLS);if(p)p.remove();}
document.addEventListener('click',function(ev){
  var t=ev.target;
  if(t instanceof Element && (t.closest('.'+PANEL_CLS)||t.closest('[class^=anchor-]')))return;
  closePanel();
});
function openPanelLoading(){closePanel();var p=document.createElement('div');p.className=PANEL_CLS;p.setAttribute('role','listbox');p.setAttribute('aria-busy','true');p.textContent='加载中...';document.body.appendChild(p);return p;}
function fillOptions(p,items,onPick){
  p.setAttribute('aria-busy','false');p.replaceChildren();
  items.forEach(function(it){
    var o=document.createElement('div');o.className=OPT_CLS;o.setAttribute('role','option');
    o.setAttribute('value',it.value);o.textContent=it.label;
    o.addEventListener('click',function(){onPick(it);closePanel();});
    p.appendChild(o);
  });
}
function openOptions(items,onPick,delayMs){
  var p=openPanelLoading();
  setTimeout(function(){fillOptions(p,items,onPick);},delayMs==null?150:delayMs);
}
function submitPayload(payload){
  return fetch('/records?cell='+CELL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})
    .then(function(r){return r.json();})
    .then(function(d){
      document.querySelector('[class^=result-]').textContent='提交成功 seq='+(d.seq!==undefined?d.seq:'?');
      document.body.setAttribute('data-done','yes');
    });
}
function onSubmit(fn){document.querySelector('button[class^=submit-]').addEventListener('click',fn);}
${script}
</script></body></html>`;
}

const PAGES: Record<string, { title: string; build: PageBuilder }> = {
  c1: {
    title: 'C1 原生多选下拉',
    build: ({ fi }) => fi(null, `<select multiple name="tags" size="4">
  <option value="T1">标签一</option>
  <option value="T2">标签二</option>
  <option value="T3">标签三</option>
  <option value="T4">标签四</option>
</select>`),
  },
  c2: {
    title: 'C2 文件上传（单文件）',
    build: ({ fi }) => fi('发票附件', `<input type="file" name="attachment" accept="image/*,.pdf">`, true),
  },
  c3: {
    title: 'C3 文件上传（多文件）',
    build: ({ fi }) => fi(null, `<input type="file" name="attachments" multiple>`),
  },
  c4: {
    title: 'C4 富文本 contenteditable',
    build: ({ fi, hash }) => fi('报销说明', `<div class="editor-${hash}" contenteditable="true" data-field="content" style="min-height:80px;border:1px solid #dcdfe6;border-radius:4px;padding:8px"></div>`),
  },
  c5: {
    title: 'C5 级联选择（本地 + 远程）',
    build: ({ fi, hash }) => fi('所属地区', `
<div>
  <div class="muted-${hash}">本地数据级联</div>
  <button type="button" class="anchor-${hash} lv-${hash}" data-chain="local" data-level="0">请选择</button>
  <button type="button" class="anchor-${hash} lv-${hash}" data-chain="local" data-level="1" disabled>请选择</button>
  <button type="button" class="anchor-${hash} lv-${hash}" data-chain="local" data-level="2" disabled>请选择</button>
</div>
<div style="margin-top:12px">
  <div class="muted-${hash}">远程数据级联</div>
  <button type="button" class="anchor-${hash} lv-${hash}" data-chain="remote" data-level="0">请选择</button>
  <button type="button" class="anchor-${hash} lv-${hash}" data-chain="remote" data-level="1" disabled>请选择</button>
  <button type="button" class="anchor-${hash} lv-${hash}" data-chain="remote" data-level="2" disabled>请选择</button>
</div>`),
  },
  c6: {
    title: 'C6 穿梭框',
    build: ({ fi, hash }) => fi('参会人员', `
<div style="display:flex;gap:10px;align-items:center">
  <ul class="src-${hash}" style="list-style:none;border:1px solid #dcdfe6;width:120px;margin:0;padding:0">
    <li data-value="u1" style="padding:4px 8px;cursor:pointer">张三</li>
    <li data-value="u2" style="padding:4px 8px;cursor:pointer">李四</li>
    <li data-value="u3" style="padding:4px 8px;cursor:pointer">王五</li>
    <li data-value="u4" style="padding:4px 8px;cursor:pointer">赵六</li>
  </ul>
  <div style="display:flex;flex-direction:column;gap:6px">
    <button type="button" class="add-${hash}">加入 →</button>
    <button type="button" class="remove-${hash}">← 移除</button>
  </div>
  <ul class="dst-${hash}" style="list-style:none;border:1px solid #dcdfe6;width:120px;margin:0;padding:0"></ul>
</div>`),
  },
  c7: {
    title: 'C7 树形选择',
    build: ({ fi, hash }) => fi('可见范围', `<div class="tree-${hash}">
<ul>
  <li data-node="east">
    <div class="node-${hash}"><button type="button" class="tgl-${hash}" data-node="east">＋ 华东</button><label><input type="checkbox" value="华东"> 华东</label></div>
    <ul hidden>
      <li data-node="shanghai">
        <div class="node-${hash}"><label><input type="checkbox" value="上海"> 上海</label></div>
        <ul>
          <li><div class="node-${hash}"><label><input type="checkbox" value="浦东"> 浦东</label></div></li>
          <li><div class="node-${hash}"><label><input type="checkbox" value="徐汇"> 徐汇</label></div></li>
        </ul>
      </li>
      <li data-node="hangzhou">
        <div class="node-${hash}"><label><input type="checkbox" value="杭州"> 杭州</label></div>
        <ul>
          <li><div class="node-${hash}"><label><input type="checkbox" value="西湖"> 西湖</label></div></li>
        </ul>
      </li>
    </ul>
  </li>
  <li data-node="north">
    <div class="node-${hash}"><button type="button" class="tgl-${hash}" data-node="north">＋ 华北</button><label><input type="checkbox" value="华北"> 华北</label></div>
    <ul hidden>
      <li><div class="node-${hash}"><label><input type="checkbox" value="北京"> 北京</label></div></li>
    </ul>
  </li>
</ul>
</div>`),
  },
  c8: {
    title: 'C8 数字步进',
    build: ({ fi, hash }) => fi('数量', `
<div style="display:inline-flex">
  <button type="button" class="stepbtn-${hash}" data-step="minus">−</button>
  <input type="number" name="qty" min="1" max="99" value="1" style="width:64px;text-align:center;border-left:0;border-right:0">
  <button type="button" class="stepbtn-${hash}" data-step="plus">＋</button>
</div>`, true),
  },
  c9: {
    title: 'C9 滑块',
    build: ({ fi }) => fi(null, `<input type="range" name="level" min="0" max="10" step="1" value="3">`),
  },
  c10: {
    title: 'C10 日期（浮层面板）',
    build: ({ fi, hash }) => fi('请假日期', `<div class="el-date-editor"><input type="text" name="leaveDate" readonly class="anchor-${hash}"></div>`, true),
  },
  c11: {
    title: 'C11 日期区间',
    build: ({ fi, hash }) => fi(null, `
<div>
  <span>开始</span> <input type="text" data-part="start" readonly class="anchor-${hash}">
  <span>结束</span> <input type="text" data-part="end" readonly class="anchor-${hash}">
</div>`),
  },
  c12: {
    title: 'C12 开关',
    build: ({ fi, hash }) => fi('消息通知', `<button type="button" role="switch" aria-checked="false" class="switch-${hash}">接收通知</button>`),
  },
  c13: {
    title: 'C13 标签输入',
    build: ({ fi, hash }) => fi(null, `
<div>
  <input type="text" name="tagInput" class="taginput-${hash}">
  <span class="chips-${hash}"></span>
</div>`),
  },
  c14: {
    title: 'C14 搜索型下拉（远程）',
    build: ({ fi, hash }) => fi('审批人', `<div class="el-select"><input type="text" name="approverSearch" role="combobox" aria-autocomplete="list" class="anchor-${hash}" autocomplete="off"></div>`, true),
  },
  c15: {
    title: 'C15 表格内联编辑',
    build: ({ fi, hash }) => fi('物品清单', `<table class="tbl-${hash}" border="1" cellspacing="0" style="border-collapse:collapse">
<thead><tr><th style="padding:4px 12px">项目名称</th><th style="padding:4px 12px">数量</th></tr></thead>
<tbody>
  <tr><td class="edit-${hash}" data-row="0" data-field="name" style="padding:4px 12px;cursor:pointer"><span>待填写</span></td>
      <td class="edit-${hash}" data-row="0" data-field="qty" style="padding:4px 12px;cursor:pointer"><span>0</span></td></tr>
  <tr><td class="edit-${hash}" data-row="1" data-field="name" style="padding:4px 12px;cursor:pointer"><span>待填写</span></td>
      <td class="edit-${hash}" data-row="1" data-field="qty" style="padding:4px 12px;cursor:pointer"><span>0</span></td></tr>
</tbody></table>`),
  },
  c16: {
    title: 'C16 动态增删行（含合计）',
    build: ({ fi, hash }) => fi('费用明细', `
<div>
  <button type="button" class="addrow-${hash}">添加明细</button>
  <div class="rows-${hash}"></div>
  <div style="margin-top:10px">合计金额 <span class="total-${hash}">0</span> 元</div>
</div>`),
  },
  v6: {
    title: 'V6 环境生成值',
    build: ({ fi, hash }) => `${fi('报修标题', `<input type="text" name="title">`, true)}
<div class="el-form-item"><div class="el-form-item__content muted-${hash}">
  <div>请求编号 <span class="rid-${hash}"></span></div>
  <div>设备标识 <span class="cid-${hash}"></span></div>
</div></div>`,
  },
  b1: {
    title: 'B1 复选多值（F-8 现状）',
    build: ({ fi }) => fi('福利申请', `<div>
  <label style="display:block"><input type="checkbox" name="benefit" value="A"> 医疗保险</label>
  <label style="display:block"><input type="checkbox" name="benefit" value="B"> 补充公积金</label>
  <label style="display:block"><input type="checkbox" name="benefit" value="C"> 交通补贴</label>
</div>`),
  },
  i1b: {
    title: 'I-1 形态B · 富文本组件（toolbar + contenteditable）',
    build: ({ fi, hash }) => fi('公告内容', `
<div class="rte-${hash}">
  <div class="tb-${hash}"><button type="button" data-cmd="bold">加粗</button><button type="button" data-cmd="list">插入列表</button></div>
  <div class="ed-${hash}" contenteditable="true" role="textbox" aria-label="公告内容" aria-multiline="true" style="min-height:64px;border:1px solid #dcdfe6;padding:8px"></div>
</div>`),
  },
  i3b: {
    title: 'I-3 形态B · spinbutton 自定义组件',
    build: ({ fi, hash }) => fi('数量', `
<div style="display:inline-flex;align-items:center;gap:6px">
  <button type="button" data-step="minus">−</button>
  <div class="spin-${hash}" role="spinbutton" aria-label="数量" aria-valuenow="1" aria-valuemin="1" aria-valuemax="99" tabindex="0" style="width:48px;text-align:center">1</div>
  <button type="button" data-step="plus">＋</button>
</div>`),
  },
  i4b: {
    title: 'I-4 形态B · 只读 combobox 触发器（div）',
    build: ({ fi, hash }) => fi('所属分行', `
<div class="anchor-${hash} cb-${hash}" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-label="所属分行" tabindex="0" style="border:1px solid #dcdfe6;padding:4px 8px;min-width:140px">请选择</div>`),
  },
  i7b: {
    title: 'I-7 形态B · 自定义组件动态行',
    build: ({ fi, hash }) => fi('设备清单', `
<div>
  <button type="button" class="addrow-${hash}">添加设备</button>
  <div class="rows-${hash}"></div>
  <div style="margin-top:10px">合计金额 <span class="total-${hash}">0</span> 元</div>
</div>`),
  },
  trunc: {
    title: '补充观察 · affected 截断（全选 30 项）',
    build: ({ fi }) => fi('通知范围', `
<div>
  <button type="button" data-cmd="all">全选</button>
  <div class="opts"></div>
</div>`),
  },
  navflow: {
    title: '补充观察 · 导航容灾（第一页）',
    build: () => `<div>
  <button type="button" data-nav="1">打开下一步页面</button>
</div>`,
  },
  navflow2: {
    title: '补充观察 · 导航容灾（第二页）',
    build: () => `<div><button type="button" data-nav2="1">第二页按钮</button></div>`,
  },
  t105: {
    title: 'T-105 · 同值双字段 lineage',
    build: ({ fi }) => `${fi('工作交接人', `<input type="text" name="handover">`, true)}
${fi('紧急联系人', `<input type="text" name="emergency">`, true)}`,
  },
  agroup: {
    title: 'A组回归 · 综合表单',
    build: ({ fi, hash }) => `
${fi('申请人', `<input type="text" name="applicant">`, true)}
${fi(null, `<textarea name="note" rows="2"></textarea>`)}
${fi('优先级', `<select name="priority"><option value="P1">普通</option><option value="P2">高</option></select>`, true)}
${fi('处理时限', `<fieldset style="border:0;padding:0;margin:0"><legend style="padding:0">处理时限</legend>
  <label><input type="radio" name="urgent" value="normal"> 常规</label>
  <label><input type="radio" name="urgent" value="high"> 加急</label>
</fieldset>`)}
${fi('同时抄送', `<label><input type="checkbox" name="cc"> 需要抄送</label>`)}
${fi('所属中心', `<div class="el-select"><input type="text" name="centerName" role="combobox" readonly class="anchor-${hash}"></div>`)}
<div class="el-form-item"><div class="el-form-item__content">
  <div class="draftbox-${hash}" style="border:1px dashed #dcdfe6;padding:4px 12px;cursor:pointer;display:inline-block">保存草稿</div>
  <span class="draftflag-${hash}" style="color:#67c23a"></span>
</div></div>`,
  },
};

const PAGE_SCRIPTS: Record<string, string> = {
  c1: `onSubmit(function(){
  var sel=document.querySelector('select[name=tags]');
  submitPayload({tags:[...sel.selectedOptions].map(function(o){return o.value;})});
});`,
  c2: `onSubmit(function(){
  var inp=document.querySelector('input[type=file]');
  var fd=new FormData();
  if(inp.files.length)fd.append('attachment',inp.files[0]);
  fetch('/records?cell='+CELL,{method:'POST',body:fd}).then(function(r){return r.json();}).then(function(d){
    document.querySelector('[class^=result-]').textContent='提交成功 seq='+(d.seq!==undefined?d.seq:'?');
    document.body.setAttribute('data-done','yes');
  });
});`,
  c3: `onSubmit(function(){
  var inp=document.querySelector('input[type=file]');
  var fd=new FormData();
  [...inp.files].forEach(function(f){fd.append('attachments',f);});
  fetch('/records?cell='+CELL,{method:'POST',body:fd}).then(function(r){return r.json();}).then(function(d){
    document.querySelector('[class^=result-]').textContent='提交成功 seq='+(d.seq!==undefined?d.seq:'?');
    document.body.setAttribute('data-done','yes');
  });
});`,
  c4: `onSubmit(function(){
  var ed=document.querySelector('[contenteditable]');
  submitPayload({contentHtml:ed.innerHTML,contentText:ed.innerText});
});`,
  c5: `var localData={'浙江省':{'杭州市':['西湖区','余杭区'],'宁波市':['鄞州区']},'江苏省':{'南京市':['玄武区','鼓楼区'],'苏州市':['姑苏区']}};
var sel={local:[],remote:[]};
function box(chain,level){return document.querySelector('button[data-chain='+chain+'][data-level="'+level+'"]');}
function optionsFor(chain,level){
  if(chain==='local'){
    var node=localData;
    for(var i=0;i<level;i++)node=node[sel.local[i]];
    return (Array.isArray(node)?node:Object.keys(node)).map(function(k){return{label:k,value:k};});
  }
  var parent=sel.remote.slice(0,level).join('|');
  return fetch('/api/cascade?level='+level+'&parent='+encodeURIComponent(parent)).then(function(r){return r.json();});
}
document.querySelectorAll('button[data-chain]').forEach(function(b){
  b.addEventListener('click',function(){
    var chain=b.getAttribute('data-chain'),level=+b.getAttribute('data-level');
    var p=openPanelLoading();
    Promise.resolve(optionsFor(chain,level)).then(function(items){
      setTimeout(function(){fillOptions(p,items,function(it){
        sel[chain][level]=it.value;sel[chain]=sel[chain].slice(0,level+1);
        for(var l=0;l<3;l++){var bx=box(chain,l);if(l<=level+1){bx.textContent=sel[chain][l]||'请选择';bx.disabled=false;}else{bx.textContent='请选择';bx.disabled=true;}}
      });},120);
    });
  });
});
onSubmit(function(){submitPayload({localRegion:sel.local.slice(),remoteRegion:sel.remote.slice()});});`,
  c6: `function toggle(li){li.style.background=li.style.background?'':'#f5f7fa';}
function selectedIn(ul){return [...ul.children].filter(function(li){return li.style.background;});}
document.querySelector('ul[class^=src-]').addEventListener('click',function(ev){var li=ev.target instanceof Element?ev.target.closest('li'):null;if(li)toggle(li);});
document.querySelector('ul[class^=dst-]').addEventListener('click',function(ev){var li=ev.target instanceof Element?ev.target.closest('li'):null;if(li)toggle(li);});
document.querySelector('button[class^=add-]').addEventListener('click',function(){
  selectedIn(document.querySelector('ul[class^=src-]')).forEach(function(li){li.style.background='';document.querySelector('ul[class^=dst-]').appendChild(li);});
});
document.querySelector('button[class^=remove-]').addEventListener('click',function(){
  selectedIn(document.querySelector('ul[class^=dst-]')).forEach(function(li){li.style.background='';document.querySelector('ul[class^=src-]').appendChild(li);});
});
onSubmit(function(){
  submitPayload({selected:[...document.querySelector('ul[class^=dst-]').children].map(function(li){return li.getAttribute('data-value');})});
});`,
  c7: `document.querySelectorAll('button[class^=tgl-]').forEach(function(btn){
  btn.addEventListener('click',function(){
    var ul=btn.closest('li').querySelector(':scope > ul');
    var open=ul.hasAttribute('hidden');
    if(open){ul.removeAttribute('hidden');btn.textContent=btn.textContent.replace('＋','－');}
    else{ul.setAttribute('hidden','');btn.textContent=btn.textContent.replace('－','＋');}
  });
});
document.querySelectorAll('.tree-'+HASH+' input[type=checkbox]').forEach(function(ck){
  ck.addEventListener('change',function(){
    var li=ck.closest('li');
    var kids=[...li.querySelectorAll('input[type=checkbox]')].filter(function(k){return k!==ck;});
    if(kids.length)kids.forEach(function(k){k.checked=ck.checked;});
    var parentLi=li.parentElement.closest('li');
    while(parentLi){
      var pck=parentLi.querySelector(':scope > .node-'+HASH+' > label > input[type=checkbox]');
      if(pck){
        var sibs=[...parentLi.querySelectorAll(':scope > ul input[type=checkbox]')];
        pck.checked=sibs.length>0&&sibs.every(function(s){return s.checked;});
      }
      parentLi=parentLi.parentElement.closest('li');
    }
  });
});
onSubmit(function(){
  submitPayload({nodes:[...document.querySelectorAll('.tree-'+HASH+' input[type=checkbox]')].filter(function(c){return c.checked;}).map(function(c){return c.value;})});
});`,
  c8: `var num=document.querySelector('input[name=qty]');
document.querySelector('button[data-step=minus]').addEventListener('click',function(){num.value=Math.max(1,(+num.value||1)-1);});
document.querySelector('button[data-step=plus]').addEventListener('click',function(){num.value=Math.min(99,(+num.value||0)+1);});
onSubmit(function(){submitPayload({qty:+num.value});});`,
  c9: `var range=document.querySelector('input[type=range]');
onSubmit(function(){submitPayload({level:+range.value});});`,
  c10: `var input=document.querySelector('input[name=leaveDate]');
input.addEventListener('click',function(){
  closePanel();
  var p=document.createElement('div');p.className=PANEL_CLS;p.textContent='2026年 9月';
  var grid=document.createElement('div');grid.className='daygrid-'+HASH;
  for(var d=1;d<=30;d++){
    (function(day){
      var b=document.createElement('button');b.type='button';b.className='day-'+HASH;b.textContent=day;
      b.addEventListener('click',function(ev){ev.stopPropagation();input.value='2026-09-'+(day<10?'0':'')+day;closePanel();});
      grid.appendChild(b);
    })(d);
  }
  p.appendChild(grid);document.body.appendChild(p);
});
onSubmit(function(){submitPayload({leaveDate:input.value});});`,
  c11: `var start=document.querySelector('input[data-part=start]'),end=document.querySelector('input[data-part=end]');
function openRange(){
  closePanel();
  var p=document.createElement('div');p.className=PANEL_CLS;p.textContent='2026年 9月（先选开始，再选结束）';
  var grid=document.createElement('div');grid.className='daygrid-'+HASH;
  for(var d=1;d<=30;d++){
    (function(day){
      var b=document.createElement('button');b.type='button';b.className='day-'+HASH;b.textContent=day;
      b.addEventListener('click',function(ev){
        ev.stopPropagation();
        var v='2026-09-'+(day<10?'0':'')+day;
        if(!start.value){start.value=v;}
        else if(!end.value){end.value=v;closePanel();}
      });
      grid.appendChild(b);
    })(d);
  }
  p.appendChild(grid);document.body.appendChild(p);
}
start.addEventListener('click',openRange);end.addEventListener('click',openRange);
onSubmit(function(){submitPayload({startDate:start.value,endDate:end.value});});`,
  c12: `var sw=document.querySelector('[role=switch]');
sw.addEventListener('click',function(){
  var on=sw.getAttribute('aria-checked')==='true';
  sw.setAttribute('aria-checked',on?'false':'true');
});
onSubmit(function(){submitPayload({notify:sw.getAttribute('aria-checked')==='true'});});`,
  c13: `var input=document.querySelector('input[name=tagInput]'),chips=document.querySelector('span[class^=chips-]');
function addTag(text){
  if(!text)return;
  var chip=document.createElement('span');chip.className='chip-'+HASH;chip.setAttribute('data-tag',text);
  chip.textContent=text;
  var x=document.createElement('button');x.type='button';x.className='tagx-'+HASH;x.textContent='×';
  x.addEventListener('click',function(){chip.remove();});
  chip.appendChild(x);chips.appendChild(chip);
}
input.addEventListener('keydown',function(ev){
  if(ev.key==='Enter'){ev.preventDefault();addTag(input.value.trim());input.value='';}
});
onSubmit(function(){
  submitPayload({tags:[...chips.children].map(function(c){return c.getAttribute('data-tag');})});
});`,
  c14: `var input=document.querySelector('input[name=approverSearch]');
var picked=null,timer=null;
input.addEventListener('input',function(){
  clearTimeout(timer);picked=null;
  var q=input.value;
  timer=setTimeout(function(){
    var p=openPanelLoading();
    fetch('/api/users?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(items){
      setTimeout(function(){
        fillOptions(p,items,function(it){picked=it;input.value=it.label;});
      },100);
    });
  },200);
});
onSubmit(function(){
  if(!picked){document.querySelector('[class^=result-]').textContent='尚未选择审批人';return;}
  submitPayload({approverId:picked.value,approverName:picked.label});
});`,
  c15: `document.querySelectorAll('td[class^=edit-]').forEach(function(td){
  td.addEventListener('click',function(){
    if(td.querySelector('input'))return;
    var span=td.querySelector('span');
    var input=document.createElement('input');input.type='text';input.value=span.textContent==='待填写'?'':span.textContent;
    td.replaceChild(input,span);input.focus();
    function commit(){span.textContent=input.value||'0';td.replaceChild(span,input);}
    input.addEventListener('blur',commit);
    input.addEventListener('keydown',function(ev){if(ev.key==='Enter')input.blur();});
  });
});
onSubmit(function(){
  var items=[0,1].map(function(row){
    var get=function(f){return document.querySelector('td[data-row="'+row+'"][data-field='+f+'] span').textContent;};
    return {name:get('name'),qty:+get('qty')||0};
  });
  submitPayload({items:items});
});`,
  c16: `var rows=document.querySelector('div[class^=rows-]'),total=document.querySelector('span[class^=total-]');
function recompute(){
  var sum=0;
  rows.querySelectorAll('input[data-field=amount]').forEach(function(i){sum+=+i.value||0;});
  total.textContent=sum;
}
document.querySelector('button[class^=addrow-]').addEventListener('click',function(){
  var row=document.createElement('div');row.className='row-'+HASH;row.style.cssText='display:flex;gap:6px;margin-bottom:6px';
  var mk=function(field,type){var i=document.createElement('input');i.type=type;i.setAttribute('data-field',field);
    if(type==='number'){i.style.width='72px';i.min='0';}
    i.addEventListener('input',recompute);return i;};
  var del=document.createElement('button');del.type='button';del.textContent='删除';
  del.addEventListener('click',function(){row.remove();recompute();});
  row.appendChild(mk('name','text'));row.appendChild(mk('qty','number'));row.appendChild(mk('amount','number'));row.appendChild(del);
  rows.appendChild(row);
});
onSubmit(function(){
  var items=[...rows.querySelectorAll('.row-'+HASH)].map(function(r){
    var get=function(f){return r.querySelector('input[data-field='+f+']').value;};
    return {name:get('name'),qty:+get('qty')||0,amount:+get('amount')||0};
  });
  submitPayload({items:items,totalAmount:+total.textContent||0});
});`,
  v6: `var requestId=(self.crypto&&crypto.randomUUID)?crypto.randomUUID():'id-'+Date.now()+'-'+Math.random().toString(36).slice(2);
var clientId='WEB-'+String((navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform).replace(/\\s+/g,'')+'-'+screen.width;
document.querySelector('span[class^=rid-]').textContent=requestId;
document.querySelector('span[class^=cid-]').textContent=clientId;
onSubmit(function(){
  submitPayload({
    title:document.querySelector('input[name=title]').value,
    requestId:requestId,
    clientId:clientId,
    clientTimestamp:Date.now()
  });
});`,
  b1: `onSubmit(function(){
  submitPayload({benefit:[...document.querySelectorAll('input[name=benefit]')].filter(function(c){return c.checked;}).map(function(c){return c.value;})});
});`,
  i1b: `var ed=document.querySelector('[role=textbox]');
document.querySelector('[data-cmd=bold]').addEventListener('click',function(){document.execCommand('bold');ed.focus();});
document.querySelector('[data-cmd=list]').addEventListener('click',function(){document.execCommand('insertUnorderedList');ed.focus();});
onSubmit(function(){submitPayload({contentHtml:ed.innerHTML,contentText:ed.innerText});});`,
  i3b: `var spin=document.querySelector('[role=spinbutton]');
function val(){return +spin.getAttribute('aria-valuenow')||1;}
function setVal(v){v=Math.min(99,Math.max(1,v));spin.setAttribute('aria-valuenow',String(v));spin.textContent=String(v);}
document.querySelector('button[data-step=minus]').addEventListener('click',function(){setVal(val()-1);});
document.querySelector('button[data-step=plus]').addEventListener('click',function(){setVal(val()+1);});
onSubmit(function(){submitPayload({qty:val()});});`,
  i4b: `var cb=document.querySelector('[role=combobox]');
cb.addEventListener('click',function(){
  closePanel();
  cb.setAttribute('aria-expanded','true');
  var p=document.createElement('div');p.className=PANEL_CLS;p.setAttribute('role','listbox');p.id='lb-'+HASH;
  cb.setAttribute('aria-controls',p.id);
  openOptions([{label:'北京分行',value:'B1'},{label:'上海分行',value:'B2'},{label:'深圳分行',value:'B3'}],function(it){
    cb.textContent=it.label;cb.setAttribute('data-value',it.value);cb.setAttribute('aria-expanded','false');
  },120);
});
onSubmit(function(){submitPayload({branch:cb.getAttribute('data-value')});});`,
  i7b: `var rows=document.querySelector('div[class^=rows-]'),total=document.querySelector('span[class^=total-]');
function recompute(){var s=0;rows.querySelectorAll('[data-field=amount]').forEach(function(e){s+=(+e.getAttribute('aria-valuenow'))||0;});total.textContent=s;}
document.querySelector('button[class^=addrow-]').addEventListener('click',function(){
  var row=document.createElement('div');row.className='row-'+HASH;row.style.cssText='display:flex;gap:8px;margin-bottom:6px;align-items:center';
  var name=document.createElement('div');name.contentEditable='true';name.setAttribute('role','textbox');name.setAttribute('aria-label','设备名称');name.style.cssText='min-width:120px;border:1px solid #dcdfe6;padding:2px 6px';
  var mkSpin=function(label){var sp=document.createElement('div');sp.setAttribute('role','spinbutton');sp.setAttribute('aria-label',label);sp.setAttribute('aria-valuenow','1');sp.setAttribute('aria-valuemin','1');sp.setAttribute('aria-valuemax','99');sp.setAttribute('tabindex','0');sp.textContent='1';sp.style.cssText='width:48px;text-align:center;border:1px solid #dcdfe6';return sp;};
  var qty=mkSpin('数量'),amount=mkSpin('金额');
  amount.setAttribute('aria-valuemax','99999');
  var inc=function(sp,d){sp.addEventListener('click',function(){var v=(+sp.getAttribute('aria-valuenow'))||1;v=Math.min(+(sp.getAttribute('aria-valuemax')),Math.max(1,v+d));sp.setAttribute('aria-valuenow',String(v));sp.textContent=String(v);recompute();});};
  inc(qty,1);inc(amount,100);
  var del=document.createElement('button');del.type='button';del.textContent='删除';
  del.addEventListener('click',function(){row.remove();recompute();});
  row.append(name,qty,amount,del);rows.appendChild(row);
});
onSubmit(function(){
  var items=[...rows.querySelectorAll('.row-'+HASH)].map(function(r){
    return {name:r.querySelector('[role=textbox]').innerText,qty:+r.querySelector('[aria-label=数量]').getAttribute('aria-valuenow'),amount:+r.querySelector('[aria-label=金额]').getAttribute('aria-valuenow')};
  });
  submitPayload({items:items,total:+total.textContent||0});
});`,
  trunc: `var box=document.querySelector('.opts');
for(var i=1;i<=30;i++){var l=document.createElement('label');l.style.display='block';var c=document.createElement('input');c.type='checkbox';c.name='opt';c.value='o'+i;l.append(c,' 选项'+i);box.appendChild(l);}
document.querySelector('[data-cmd=all]').addEventListener('click',function(){
  document.querySelectorAll('input[name=opt]').forEach(function(c){c.checked=true;});
});
onSubmit(function(){submitPayload({picked:[...document.querySelectorAll('input[name=opt]')].filter(function(c){return c.checked;}).length});});`,
  navflow: `document.querySelector('[data-nav]').addEventListener('click',function(){location.href='/navflow2';});`,
  navflow2: `document.querySelector('[data-nav2]').addEventListener('click',function(){document.body.setAttribute('data-clicked','yes');});`,
  t105: `onSubmit(function(){
  submitPayload({
    handover:document.querySelector('input[name=handover]').value,
    emergency:document.querySelector('input[name=emergency]').value
  });
});`,
  agroup: `var center=null;
document.querySelector('input[name=centerName]').addEventListener('click',function(){
  openOptions([{label:'综合部',value:'GEN'},{label:'研发中心',value:'RD'},{label:'运营中心',value:'OPS'}],function(it){
    center=it;document.querySelector('input[name=centerName]').value=it.label;
  },120);
});
document.querySelector('div[class^=draftbox-]').addEventListener('click',function(){
  document.querySelector('span[class^=draftflag-]').textContent='已保存草稿';
  document.body.setAttribute('data-draft','saved');
});
onSubmit(function(){
  submitPayload({
    applicant:document.querySelector('input[name=applicant]').value,
    note:document.querySelector('textarea[name=note]').value,
    priority:document.querySelector('select[name=priority]').value,
    urgent:(document.querySelector('input[name=urgent]:checked')||{}).value||null,
    cc:document.querySelector('input[name=cc]').checked,
    draftSaved:document.body.getAttribute('data-draft')==='saved',
    center:center?center.value:null,
    centerName:center?center.label:null
  });
});`,
};

export async function startMatrixServer(): Promise<MatrixServer> {
  const hash = 'z' + Math.random().toString(36).slice(2, 8);
  const store = new Map<string, StoredRecord[]>();
  let seq = 0;

  function parseMultipart(buffer: Buffer, contentType: string): { fields: Record<string, string>; files: StoredFile[] } {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
    const boundary = '--' + (match?.[1] ?? match?.[2] ?? '');
    const fields: Record<string, string> = {};
    const files: StoredFile[] = [];
    const bBuf = Buffer.from(boundary);
    let cursor = buffer.indexOf(bBuf);
    while (cursor !== -1) {
      const next = buffer.indexOf(bBuf, cursor + bBuf.length);
      if (next === -1) break;
      let segment = buffer.subarray(cursor + bBuf.length, next);
      if (segment.subarray(0, 2).toString('binary') === '\r\n') segment = segment.subarray(2);
      let end = segment.length;
      if (end >= 2 && segment.subarray(end - 2).toString('binary') === '\r\n') end -= 2;
      const headerEnd = segment.indexOf('\r\n\r\n');
      if (headerEnd !== -1) {
        const headers: Record<string, string> = {};
        for (const line of segment.subarray(0, headerEnd).toString('utf8').split('\r\n')) {
          const idx = line.indexOf(':');
          if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
        }
        const disposition = headers['content-disposition'] ?? '';
        const nameMatch = /name="([^"]*)"/.exec(disposition);
        const fileMatch = /filename="([^"]*)"/.exec(disposition);
        const field = nameMatch?.[1] ?? '';
        const body = segment.subarray(headerEnd + 4, end);
        if (fileMatch && field) {
          files.push({
            field,
            filename: fileMatch[1] ?? '',
            size: body.length,
            contentType: headers['content-type'] ?? 'application/octet-stream',
          });
        } else if (field) {
          fields[field] = body.toString('utf8');
        }
      }
      cursor = next;
    }
    return { fields, files };
  }

  function renderPage(cell: string): string {
    const page = PAGES[cell];
    if (!page) return shell(cell, '未知页面', hash, '', '');
    const body = page.build({ hash, fi: formItem });
    return shell(cell, page.title, hash, body, PAGE_SCRIPTS[cell] ?? '');
  }

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://matrix.invalid');
    const path = url.pathname;
    const cell = url.searchParams.get('cell') ?? '';
    if (request.method === 'GET' && path === '/probe') {
      response.setHeader('content-type', 'application/json');
      response.end('{"active":true}');
      return;
    }
    if (request.method === 'GET' && path === '/identity') {
      response.setHeader('content-type', 'application/json');
      response.end('{"principal":"matrix-user"}');
      return;
    }
    if (request.method === 'GET' && path === '/api/users') {
      const q = url.searchParams.get('q') ?? '';
      setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(USERS.filter((user) => user.label.includes(q))));
      }, 150);
      return;
    }
    if (request.method === 'GET' && path === '/api/cascade') {
      const level = url.searchParams.get('level') ?? '0';
      const parent = url.searchParams.get('parent') ?? '';
      const key = level === '0' ? 'l0' : `${parent}.l${level}`;
      setTimeout(() => {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(CASCADE_REMOTE[key] ?? []));
      }, 150);
      return;
    }
    if (path === '/records' && cell) {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(store.get(cell) ?? []));
        return;
      }
      if (request.method === 'DELETE') {
        store.delete(cell);
        response.setHeader('content-type', 'application/json');
        response.end('{"ok":true}');
        return;
      }
      if (request.method === 'POST') {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
          const buffer = Buffer.concat(chunks);
          const contentType = request.headers['content-type'] ?? '';
          const record: StoredRecord = {
            cell,
            seq: ++seq,
            ts: Date.now(),
            method: 'POST',
            contentType,
            raw: buffer.length ? buffer.toString('utf8') : null,
            parsed: null,
            query: url.searchParams.toString(),
          };
          if (contentType.includes('multipart/form-data')) {
            const { fields, files } = parseMultipart(buffer, contentType);
            record.parsed = { fields, files };
            record.files = files;
          } else if (contentType.includes('application/json') && buffer.length) {
            try {
              record.parsed = JSON.parse(buffer.toString('utf8'));
            } catch {
              record.parsed = { parseError: true };
            }
          } else {
            record.parsed = { fields: Object.fromEntries(new URLSearchParams(buffer.toString('utf8'))) };
          }
          const list = store.get(cell) ?? [];
          list.push(record);
          store.set(cell, list);
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ ok: true, seq: record.seq }));
        });
        return;
      }
    }
    if (request.method === 'GET' && PAGES[path.slice(1)]) {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.end(renderPage(path.slice(1)));
      return;
    }
    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('matrix fixture did not bind');

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    hash,
    records: (forCell) => (store.get(forCell) ?? []).map((item) => ({ ...item })),
    clear: (forCell) => store.delete(forCell),
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
