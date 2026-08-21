import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyCookieKind, launchDSHContext, probeSessionType } from '@dsh/browser';
import { draftEntryYaml } from '@dsh/browser';

export interface FrontendProbeResult {
  vue: number | null;
  ui: 'element-plus' | 'element-ui' | null;
  evidence: string[];
}

export interface DoctorOptions {
  probeFrontend?: string;
  /** 【T-58】entry 探测：--probe-entry --portal <url> --target <id> 或 --direct <url> */
  probeEntry?: boolean;
  portal?: string;
  target?: string;
  direct?: string;
  /** entry 输出目录（探测结果写入 entries/<id>.yaml 供人工复核） */
  entries?: string;
  /** 【probe-entry 专用】使用指定持久 profile（探测需在已登录会话上进行） */
  profile?: string;
  sessionStrategy?: 'daemon' | 'storage-state' | 'probe-only';
}

export async function runDoctor(options: DoctorOptions): Promise<void> {
  const profileDir = options.profile ?? (await mkdtemp(join(tmpdir(), 'dsh-doctor-')));
  const channel = process.env.DSH_CHANNEL === 'msedge' ? 'msedge' : 'chrome';
  const context = await launchDSHContext({ profileDir, channel, headless: true });
  try {
    const page = await context.newPage();
    await page.goto('data:text/html,<h1>DSH Doctor</h1>');
    const runtime = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      locator: typeof Reflect.get(window, '__DSH_LOCATOR__'),
      snapshot: typeof Reflect.get(window, '__DSH_SNAPSHOT__'),
      generator: typeof Reflect.get(window, '__DSH_PWGEN__'),
    }));
    const chromeVersion = /(?:Chrome|Edg)\/([\d.]+)/.exec(runtime.userAgent)?.[1] ?? '未知';
    console.log(`✓ ${channel === 'msedge' ? 'Edge' : 'Chrome'} 已安装        版本 ${chromeVersion}`);
    console.log('✓ 可启动 persistent context');
    const injected =
      runtime.locator === 'object' && runtime.snapshot === 'function' && runtime.generator === 'function';
    console.log(`${injected ? '✓' : '✗'} IIFE 注入${injected ? '成功' : '失败'}`);
    console.log('? 认证类型            需人工确认（A: Kerberos / B: 表单 / C: 证书）');
    console.log(`✓ 代理配置            ${process.env.HTTPS_PROXY || process.env.HTTP_PROXY ? '已设置' : '未设置'}`);
    console.log('? remote-debugging    需在目标企业策略环境确认');
    console.log('? 前端框架            需在目标页面执行 --probe-frontend 探测');

    if (options.probeFrontend) {
      const result = await probeFrontend(page, options.probeFrontend);
      printFrontendProbe(options.probeFrontend, result);
    }
    if (options.probeEntry) {
      await printEntryProbe(page, options);
    }
  } finally {
    await context.close();
    // 指定的持久 profile 不删除（--probe-entry 复用已登录会话）
    if (!options.profile) await rm(profileDir, { recursive: true, force: true });
  }
}

/** 【T-58】entry 探测：sessionType + 通道能力 + entry YAML 草稿。 */
async function printEntryProbe(
  page: import('playwright').Page,
  options: DoctorOptions,
): Promise<void> {
  const url = options.direct ?? options.portal;
  const targetId = options.target ?? (options.direct ? 'direct' : 'oa');
  if (!url) throw new Error('--probe-entry 需要 --direct <url> 或 --portal <url>');
  console.log(`\nEntry 探测：${targetId}（${url}）`);
  console.log('────────────────────────────────────────');
  await page.goto(url);
  await page.waitForTimeout(2_000);

  const probe = await probeSessionType(page);
  const cookieKind = classifyCookieKind(await page.context().cookies());
  console.log(`sessionType     ${probe.sessionType}`);
  console.log(`cookieKind      ${cookieKind}`);
  if (cookieKind === 'session' && options.sessionStrategy === 'storage-state') {
    console.log('⚠ 会话 cookie 依赖快照文件保存真实凭证，风险较高，建议改用 daemon');
  }
  if (probe.bearerSource) console.log(`bearerSource    ${probe.bearerSource.strategy}`);
  console.log(
    `通道能力        network ${probe.channelCapability.network ? '✓' : '✗'}   ui ${probe.channelCapability.ui ? '✓' : '✗'}`,
  );
  console.log(`证据            ${probe.evidence.join('  ')}`);
  if (probe.sessionType === 'bearer' && probe.bearerSource?.strategy === 'ui-only') {
    console.log('⚠ bearer/ui-only：该系统技能必须全部 channel: ui（C18）');
  }
  const yaml = draftEntryYaml({
    id: targetId,
    name: targetId,
    via: options.direct ? 'direct' : 'portal',
    directUrl: options.direct,
    portalUrl: options.portal,
    landingUrlPattern: '/',
    sessionType: probe.sessionType,
    ...(probe.bearerSource ? { bearerSource: probe.bearerSource } : {}),
    channelCapability: probe.channelCapability,
    cookieKind,
    ...(options.sessionStrategy ? { sessionStrategy: options.sessionStrategy } : {}),
  });
  const entriesDir = options.entries ?? './entries';
  const { mkdir, writeFile: writeEntryFile } = await import('node:fs/promises');
  const { resolve: resolvePath, join: joinPath } = await import('node:path');
  await mkdir(entriesDir, { recursive: true });
  const outPath = joinPath(resolvePath(entriesDir), `${targetId}.yaml`);
  await writeEntryFile(outPath, yaml, 'utf8');
  console.log('────────────────────────────────────────');
  console.log(`已生成 ${outPath}，请人工复核后使用`);
}

export async function probeFrontend(page: import('playwright').Page, url: string): Promise<FrontendProbeResult> {
  await page.goto(url);
  return page.evaluate(() => {
    const result: FrontendProbeResult = { vue: null, ui: null, evidence: [] };
    const runtimeWindow = window as typeof window & {
      __VUE__?: unknown;
      Vue?: { version?: string };
    };
    if (runtimeWindow.__VUE__) {
      result.vue = 3;
      result.evidence.push('window.__VUE__');
    } else if (runtimeWindow.Vue?.version) {
      result.vue = Number.parseInt(runtimeWindow.Vue.version, 10);
      result.evidence.push(`Vue.version=${runtimeWindow.Vue.version}`);
    } else if (document.querySelector('[data-v-app]')) {
      result.vue = 3;
      result.evidence.push('[data-v-app]');
    }

    if (document.querySelector('.el-config-provider, .el-overlay')) {
      result.ui = 'element-plus';
      result.evidence.push('.el-overlay / .el-config-provider');
    } else if (document.querySelector('.el-dialog__wrapper, .v-modal')) {
      result.ui = 'element-ui';
      result.evidence.push('.el-dialog__wrapper / .v-modal');
    }
    return result;
  });
}

export function frontendConclusion(result: FrontendProbeResult): string {
  return result.vue === 2 && result.ui === 'element-ui'
    ? '需启用 T-09-vue2 / T-13 / A8'
    : '无需启用 Vue2 条件任务';
}

function printFrontendProbe(url: string, result: FrontendProbeResult): void {
  console.log(`\n前端框架探测结果（${url}）`);
  console.log(`  Vue 版本      : ${result.vue ?? '未知'}`);
  console.log(`  组件库        : ${result.ui ?? '未知'}`);
  console.log(`  依据          : ${result.evidence.join(', ') || '无可靠证据'}`);
  console.log(`  → 结论：${frontendConclusion(result)}`);
}
