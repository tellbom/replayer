import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

const pngBytes = (size: number): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size, 7)]);



export async function waitDone(page: Page): Promise<void> {
  await page.waitForFunction(() => document.body.dataset.done === 'yes', undefined, { timeout: 20_000 });
}

export async function clickSubmit(page: Page): Promise<void> {
  await page.locator('button[class^=submit-]').click();
}

export interface CellSpec {
  cell: string;
  desc: string;
  operate: (page: Page, base: string, extra: Record<string, unknown>) => Promise<void>;
  /** 录制前准备（如生成上传文件）；返回值并入 replay1 参数 */
  prepare?: (outDir: string) => Promise<Record<string, unknown>>;
  /** 录制请求体不可用（multipart）时的 replay1 参数补充 */
  replay1Fallback?: Record<string, unknown>;
  /** 跨参数回放的替换值 */
  altParams?: Record<string, unknown>;
  /** 跨参数回放的目标请求体：按 draft 模板路径反推参数值（用于参数名与字段名不一致的格子） */
  altBody?: Record<string, unknown>;
}

export const CELLS: CellSpec[] = [
  {
    cell: 'c2',
    desc: 'C2 文件上传（单文件）',
    prepare: async (outDir) => {
      const dir = join(outDir, 'upload');
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'invoice-receipt.png');
      await writeFile(path, pngBytes(2048));
      return { __uploadPath: path };
    },
    operate: async (page, _base, extra) => {
      const uploadPath = extra.__uploadPath as string;
      await page.locator('input[type=file]').setInputFiles(uploadPath!);
      await page.waitForTimeout(300);
      await clickSubmit(page);
      await waitDone(page);
    },
    replay1Fallback: { attachment: 'C:\\fakepath\\invoice-receipt.png' },
    altParams: { attachment: '替换-发票.png' },
  },
  {
    cell: 'c3',
    desc: 'C3 文件上传（多文件）',
    prepare: async (outDir) => {
      const dir = join(outDir, 'upload');
      await mkdir(dir, { recursive: true });
      const first = join(dir, 'expense-detail.pdf');
      const second = join(dir, 'receipt-2.png');
      await writeFile(first, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1024, 3)]));
      await writeFile(second, pngBytes(512));
      return { __uploadPaths: [first, second] };
    },
    operate: async (page, _base, extra) => {
      const paths = extra.__uploadPaths as string[];
      await page.locator('input[type=file]').setInputFiles(paths!);
      await page.waitForTimeout(300);
      await clickSubmit(page);
      await waitDone(page);
    },
    replay1Fallback: { attachments: ['C:\\fakepath\\expense-detail.pdf', 'C:\\fakepath\\receipt-2.png'] },
    altParams: { attachments: ['替换-a.pdf', '替换-b.png'] },
  },
  {
    cell: 'c16',
    desc: 'C16 动态增删行 + V8 计算合计',
    operate: async (page) => {
      const add = page.locator('button[class^=addrow-]');
      await add.click();
      await add.click();
      const rows = page.locator('div[class^=row-]');
      await rows.nth(0).locator('input[data-field=name]').fill('差旅住宿');
      await rows.nth(0).locator('input[data-field=qty]').fill('2');
      await rows.nth(0).locator('input[data-field=amount]').fill('800');
      await rows.nth(1).locator('input[data-field=name]').fill('市内交通');
      await rows.nth(1).locator('input[data-field=qty]').fill('5');
      await rows.nth(1).locator('input[data-field=amount]').fill('60');
      await page.waitForTimeout(200);
      await clickSubmit(page);
      await waitDone(page);
    },
    altBody: {
      items: [
        { name: '打印耗材', qty: 3, amount: 120 },
        { name: '快递费', qty: 6, amount: 35 },
      ],
      totalAmount: 155,
    },
  },
  {
    cell: 'c1',
    desc: 'C1 原生多选下拉',
    operate: async (page) => {
      await page.locator('select[name=tags]').selectOption(['T1', 'T3']);
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { tags: ['T2', 'T4'] },
  },
  {
    cell: 'c5',
    desc: 'C5 级联选择（本地+远程）',
    operate: async (page) => {
      await page.locator('button[data-chain=local][data-level="0"]').click();
      await page.getByRole('option', { name: '浙江省', exact: true }).click();
      await page.locator('button[data-chain=local][data-level="1"]').click();
      await page.getByRole('option', { name: '杭州市', exact: true }).click();
      await page.locator('button[data-chain=local][data-level="2"]').click();
      await page.getByRole('option', { name: '西湖区', exact: true }).click();
      await page.locator('button[data-chain=remote][data-level="0"]').click();
      await page.getByRole('option', { name: '江苏省', exact: true }).click();
      await page.locator('button[data-chain=remote][data-level="1"]').click();
      await page.getByRole('option', { name: '南京市', exact: true }).click();
      await page.locator('button[data-chain=remote][data-level="2"]').click();
      await page.getByRole('option', { name: '鼓楼区', exact: true }).click();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { localRegion: ['江苏省', '苏州市', '姑苏区'], remoteRegion: ['广东省', '广州市', '天河区'] },
  },
  {
    cell: 'c13',
    desc: 'C13 标签输入',
    operate: async (page) => {
      const input = page.locator('input[name=tagInput]');
      await input.fill('紧急补贴');
      await input.press('Enter');
      await input.fill('需发票');
      await input.press('Enter');
      await input.fill('月度报销');
      await input.press('Enter');
      await page.locator('button[class^=tagx-]').first().click();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { tags: ['常规', '无需审批'] },
  },
  {
    cell: 'c4',
    desc: 'C4 富文本 contenteditable',
    operate: async (page) => {
      const editor = page.locator('[contenteditable=true]');
      await editor.click();
      await page.keyboard.type('第三季度预算说明：含差旅与采购');
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { contentHtml: '<p>替代内容</p>', contentText: '替代内容' },
  },
  {
    cell: 'c6',
    desc: 'C6 穿梭框',
    operate: async (page) => {
      await page.locator('ul[class^=src-] li').filter({ hasText: '李四' }).click();
      await page.locator('ul[class^=src-] li').filter({ hasText: '王五' }).click();
      await page.locator('button[class^=add-]').click();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { selected: ['u1', 'u4'] },
  },
  {
    cell: 'c7',
    desc: 'C7 树形选择',
    operate: async (page) => {
      await page.locator('button[class^=tgl-]').filter({ hasText: '华东' }).click();
      await page.locator('input[type=checkbox][value=上海]').check();
      await clickSubmit(page);
      await waitDone(page);
    },
    altBody: { nodes: ['华北', '北京'] },
  },
  {
    cell: 'c8',
    desc: 'C8 数字步进',
    operate: async (page) => {
      for (let i = 0; i < 4; i += 1) {
        await page.locator('button[data-step=plus]').click();
      }
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { qty: 9 },
  },
  {
    cell: 'c9',
    desc: 'C9 [long-term] 滑块',
    operate: async (page) => {
      await page.locator('input[type=range]').focus();
      for (let i = 0; i < 4; i += 1) {
        await page.keyboard.press('ArrowRight');
      }
      await clickSubmit(page);
      await waitDone(page);
    },
    altBody: { level: 2 },
  },
  {
    cell: 'c10',
    desc: 'C10 日期（浮层面板）',
    operate: async (page) => {
      await page.locator('input[name=leaveDate]').click();
      await page.getByRole('button', { name: '15', exact: true }).click();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { leaveDate: '2026-09-22' },
  },
  {
    cell: 'c11',
    desc: 'C11 日期区间',
    operate: async (page) => {
      await page.locator('input[data-part=start]').click();
      await page.getByRole('button', { name: '5', exact: true }).click();
      await page.getByRole('button', { name: '18', exact: true }).click();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { startDate: '2026-09-03', endDate: '2026-09-12' },
  },
  {
    cell: 'c12',
    desc: 'C12 开关',
    operate: async (page) => {
      await page.locator('[role=switch]').click();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { notify: false },
  },
  {
    cell: 'c14',
    desc: 'C14 [long-term] 搜索型下拉（远程）',
    operate: async (page) => {
      await page.locator('input[name=approverSearch]').click();
      await page.locator('input[name=approverSearch]').fill('王');
      await page.getByRole('option', { name: '王五', exact: true }).click();
      await clickSubmit(page);
      await waitDone(page);
    },
    replay1Fallback: { 审批人: '王' },
    altBody: { approverId: 'u4', approverName: '王小明' },
  },
  {
    cell: 'c15',
    desc: 'C15 表格内联编辑',
    operate: async (page) => {
      await page.locator('td[data-row="0"][data-field="name"]').click();
      await page.keyboard.type('会议室预定');
      await page.keyboard.press('Tab');
      await page.locator('td[data-row="0"][data-field="qty"]').click();
      await page.keyboard.type('3');
      await page.keyboard.press('Tab');
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { items: [{ name: '保洁服务', qty: 8 }, { name: '待填写', qty: 0 }] },
  },
  {
    cell: 'b1',
    desc: 'B1 复选多值（F-8 现状）',
    operate: async (page) => {
      await page.locator('input[name=benefit][value=A]').check();
      await page.locator('input[name=benefit][value=C]').check();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { benefit: ['B'] },
  },
  {
    cell: 'v6',
    desc: 'V6 环境生成值',
    operate: async (page) => {
      await page.locator('input[name=title]').fill('设备报修');
      await clickSubmit(page);
      await waitDone(page);
    },
    altBody: { title: '设备搬迁' },
  },
  {
    cell: 'agroup',
    desc: 'A组回归 · 综合表单（A1-A7）',
    operate: async (page) => {
      await page.locator('input[name=applicant]').fill('行政部-张三');
      await page.locator('textarea[name=note]').fill('备注内容一行');
      await page.locator('select[name=priority]').selectOption('P2');
      await page.locator('input[name=urgent][value=high]').check();
      await page.locator('input[name=cc]').check();
      await page.locator('div[class^=draftbox-]').click();
      await page.locator('input[name=centerName]').click();
      await page.getByRole('option', { name: '研发中心', exact: true }).click();
      await clickSubmit(page);
      await waitDone(page);
    },
    altParams: { applicant: '研发部-李四', note: '替代备注', priority: 'P1', urgent: 'normal', center: 'OPS', centerName: '运营中心' },
  },
];
