import { expect, test, type Page } from '@playwright/test';
import type { ExecContext, Step } from '@dsh/core';
import { readFile } from 'node:fs/promises';

import { executeUiStep } from '../packages/replayer/src/channel-ui.js';
import { resolveVirtualItem } from '../packages/replayer/src/virtual-list.js';

test('T-73 H1-H5: portal、异步选项、日期直写、弹窗 scope 与条件字段重建', async ({ page }) => {
  await page.goto('/');
  await page.setContent(`
    <button id="select">选择</button><input id="remote"><input id="date">
    <button id="submit">提交</button><button>确定</button>
    <select id="condition"><option value="hide">隐藏</option><option value="show">显示</option></select>
    <div id="conditional"></div>
    <script>
      select.onclick = () => { const panel=document.createElement('div'); panel.role='listbox'; panel.innerHTML='<div role="option">工作日</div>'; document.body.append(panel); };
      remote.oninput = async () => { await fetch('/api/remote?q='+remote.value); const panel=document.createElement('div'); panel.role='listbox'; panel.innerHTML='<div role="option">'+remote.value+'-结果</div>'; document.body.append(panel); };
      submit.onclick = () => { const dialog=document.createElement('div'); dialog.role='dialog'; dialog.setAttribute('aria-label','确认提交'); dialog.innerHTML='<button>确定</button>'; document.body.append(dialog); };
      condition.onchange = () => { conditional.replaceChildren(); if(condition.value==='show'){ const field=document.createElement('div'); field.className='el-form-item'; field.textContent='调休说明'; conditional.append(field); } };
    </script>`);
  await injectMutationTracker(page);

  await page.evaluate(() => window.__DSH_MUTATION__.begin(1));
  await page.locator('#select').click();
  expect(await roots(page, 1)).toEqual([
    expect.objectContaining({ kind: 'listbox', portaled: true }),
  ]);

  await page.route('**/api/remote?q=alpha', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ json: { ok: true } });
  });
  const response = page.waitForResponse('**/api/remote?q=alpha');
  await page.locator('#remote').fill('alpha');
  await response;
  await expect(page.getByRole('option', { name: 'alpha-结果' })).toBeVisible();

  await page.locator('#date').fill('2026-08-21 09:00:00');
  await expect(page.locator('#date')).toHaveValue('2026-08-21 09:00:00');

  await page.locator('#submit').click();
  const dialog = page.getByRole('dialog', { name: '确认提交' });
  await expect(dialog.getByRole('button', { name: '确定' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '确定' })).toHaveCount(2);

  await page.locator('#condition').selectOption('show');
  await expect(page.getByText('调休说明')).toBeVisible();
  await page.locator('#condition').selectOption('hide');
  await expect(page.getByText('调休说明')).toHaveCount(0);
  await page.locator('#condition').selectOption('show');
  await expect(page.getByText('调休说明')).toBeVisible();
});

test('T-73 H6-H10: 动态行、懒折叠、向导、抽屉与虚拟列表', async ({ page }) => {
  await page.setContent(`
    <button id="add">添加明细</button><table><tbody id="rows"></tbody></table>
    <button id="collapse">展开费用</button><div id="collapse_body"></div>
    <section id="wizard"><button id="next">下一步</button></section>
    <button id="detail">详情</button>
    <input id="search"><div id="search_results"></div>
    <div id="virtual" style="height:100px;overflow:auto;position:relative"><div style="height:1200px"></div><div class="virtual-item" style="position:absolute;top:0"></div></div>
    <script>
      add.onclick=()=>{const row=document.createElement('tr');row.className='el-table__row';row.innerHTML='<td>项目'+(rows.children.length+1)+'</td><td><button>编辑</button></td>';rows.append(row)};
      collapse.onclick=()=>{collapse_body.innerHTML='<div class="el-collapse-item">报销内容</div>'};
      next.onclick=()=>{wizard.innerHTML='<h2>第二步</h2><input aria-label="审批意见">'};
      detail.onclick=()=>{const drawer=document.createElement('aside');drawer.className='el-drawer';drawer.innerHTML='<h2>详情抽屉</h2>';document.body.append(drawer)};
      search.oninput=()=>{search_results.innerHTML='<div class="search-item">'+search.value+'</div>'};
      const virtual=document.querySelector('#virtual'), item=document.querySelector('.virtual-item');
      const render=()=>{const index=Math.floor(virtual.scrollTop/100);item.textContent='Item '+index;item.style.top=virtual.scrollTop+'px'};virtual.onscroll=render;render();
    </script>`);

  await page.locator('#add').click();
  await page.locator('#add').click();
  await expect(
    page
      .locator('.el-table__row')
      .filter({ hasText: '项目2' })
      .getByRole('button', { name: '编辑' }),
  ).toHaveCount(1);
  await expect(page.getByText('报销内容')).toHaveCount(0);
  await page.locator('#collapse').click();
  await expect(page.getByText('报销内容')).toBeVisible();
  await page.locator('#next').click();
  await expect(page.getByRole('heading', { name: '第二步' })).toBeVisible();
  await expect(page.locator('#next')).toHaveCount(0);
  await page.locator('#detail').click();
  await expect(page.locator('.el-drawer').getByRole('heading', { name: '详情抽屉' })).toBeVisible();

  const searched = await resolveVirtualItem(page, {
    container: '#search_results',
    item: '.search-item',
    text: 'Item 900',
    search: '#search',
  });
  await expect(searched).toHaveText('Item 900');
  const scrolled = await resolveVirtualItem(page, {
    container: '#virtual',
    item: '.virtual-item',
    text: 'Item 5',
    maxSegments: 10,
  });
  await expect(scrolled).toHaveText('Item 5');
});

test('T-73 I1-I5: 菜单、SPA 双条件、tabs、面包屑与新标签页', async ({ page, context }) => {
  await page.goto('/');
  await page.setContent(`
    <button id="menu">考勤管理</button><div id="menu_root"></div>
    <button id="route">加班申请</button><div id="route_root"></div>
    <button id="tab">审批记录</button><div id="tab_root"></div>
    <input id="form"><button id="detail">进入详情</button><div id="view"></div>
    <button id="popup">新窗口</button>
    <script>
      menu.onclick=()=>menu_root.innerHTML='<div role="menu"><button role="menuitem">加班申请</button></div>';
      route.onclick=()=>{history.pushState({},'', '/dynamic-route');route_root.innerHTML='<h1>加班申请页</h1>'};
      tab.onclick=()=>tab_root.innerHTML='<section role="tabpanel">审批记录内容</section>';
      detail.onclick=()=>{view.innerHTML='<a id="crumb">返回申请</a>';crumb.onclick=()=>{view.innerHTML='<input id="returned-form">'}};
      document.querySelector('#popup').onclick=()=>{const child=window.open('about:blank','_blank');child.document.body.innerHTML='<h1>新标签详情</h1>'};
    </script>`);

  await page.locator('#menu').click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: '加班申请' })).toBeVisible();
  await page.locator('#route').click();
  await expect(page).toHaveURL(/\/dynamic-route$/);
  await expect(page.getByRole('heading', { name: '加班申请页' })).toBeVisible();
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  await page.locator('#tab').click();
  await expect(page.getByRole('tabpanel')).toHaveText('审批记录内容');
  await page.locator('#form').fill('原状态');
  await page.locator('#detail').click();
  await page.locator('#crumb').click();
  await expect(page.locator('#returned-form')).toHaveValue('');
  const popupPromise = context.waitForEvent('page');
  await page.evaluate(() => window.open('about:blank', '_blank'));
  const popup = await popupPromise;
  await popup.setContent('<h1>新标签详情</h1>');
  await expect(popup.getByRole('heading', { name: '新标签详情' })).toBeVisible();
});

test('T-73 I6: frame-playwright 通过 frameLocator 执行 iframe 内动作', async ({ page }) => {
  await page.setContent(
    `<iframe id="legacy" srcdoc="<button onclick=&quot;parent.document.body.dataset.frameClicked='yes'&quot;>老系统提交</button>"></iframe>`,
  );
  const step: Step = {
    id: 'iframe-click',
    desc: '点击 iframe 按钮',
    channel: 'ui',
    riskLevel: 'read',
    hasSideEffect: false,
    requires: [],
    ui: {
      action: 'click',
      target: {
        strategy: 'frame-playwright',
        frame: '#legacy',
        selector: 'button',
        confidence: 'HIGH',
      },
    },
  };
  const execContext = {
    params: {},
    vars: {},
    stepResults: {},
    baseUrl: 'http://test',
    entry: undefined as never,
    identityDigest: '',
    scopes: {},
  } satisfies ExecContext;
  await executeUiStep(page, step, execContext, []);
  await expect(page.locator('body')).toHaveAttribute('data-frame-clicked', 'yes');
});

async function injectMutationTracker(page: Page): Promise<void> {
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/selector-generator.iife.js', 'utf8'),
  });
  await page.addScriptTag({
    content: await readFile('packages/locator/dist/mutation-tracker.iife.js', 'utf8'),
  });
}

async function roots(
  page: Page,
  actionIdx: number,
): Promise<Array<{ kind: string; portaled: boolean }>> {
  return page.evaluate(async (index) => {
    const result = await window.__DSH_MUTATION__.end(index);
    return result.map(({ kind, portaled }) => ({ kind, portaled }));
  }, actionIdx);
}
