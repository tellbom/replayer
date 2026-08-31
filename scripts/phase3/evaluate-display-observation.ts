import { resolve } from 'node:path';

import { chromium, type Page } from 'playwright';

import { CELLS } from '../../e2e/matrix/cells.js';
import { startMatrixServer } from '../../e2e/matrix/matrix-fixture.js';

interface DisplayMeasurement {
  initialValueCarriers: number;
  finalValueCarriers: number;
  initialDisplayCandidates: number;
  finalDisplayCandidates: number;
  observerCallbacks: number;
  observerCallbackTotalMs: number;
  observerCallbackMaxMs: number;
  changedDisplayElements: number;
  changedTextBytes: number;
  sanitizedTextBytes: number;
  requestConsumedDisplayValues: number;
}

const fixture = await measureFixture();
const realSystem = process.env.PHASE3_SKIP_REAL === '1'
  ? null
  : await measureRealSystem();

process.stdout.write(`${JSON.stringify({ fixture, realSystem }, null, 2)}\n`);

async function measureFixture(): Promise<DisplayMeasurement> {
  const spec = CELLS.find((candidate) => candidate.cell.toLowerCase() === 'c16');
  if (!spec) throw new Error('C16 fixture is unavailable');
  const server = await startMatrixServer();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(`${request.url()}\n${request.postData() ?? ''}`));
    await page.goto(`${server.baseUrl}/${spec.cell}`);
    await page.locator('button[class^=submit-]').waitFor({ state: 'visible' });
    await installDisplayMeasurement(page);
    await spec.operate(page, server.baseUrl, {});
    return await finishDisplayMeasurement(page, requests);
  } finally {
    await browser.close();
    await server.close();
  }
}

async function measureRealSystem(): Promise<DisplayMeasurement> {
  const profile = resolve(
    process.env.PHASE3_REAL_PROFILE
      ?? 'tmp/phase3-predelete/real-system/profile',
  );
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome',
    headless: true,
  });
  try {
    const page = context.pages()[0] ?? await context.newPage();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(`${request.url()}\n${request.postData() ?? ''}`));
    await page.goto('http://localhost:5173/#/dashboard', { waitUntil: 'networkidle' });
    if (!await page.title().then((title) => title.includes('企业OA系统'))) {
      throw new Error('real-system profile is not authenticated');
    }
    await installDisplayMeasurement(page);

    await page.getByRole('button', { name: /我的申请/ }).click();
    await page.waitForURL(/#\/applications/);
    await page.getByRole('button', { name: '新建请假' }).click();
    await page.waitForURL(/#\/leave\/new/);

    const nativeSelect = page.locator('select').first();
    if (await nativeSelect.count()) await nativeSelect.selectOption({ index: 2 });

    const radio = page.getByText('下午', { exact: true }).first();
    if (await radio.count()) await radio.click();

    const remoteSearch = page.getByPlaceholder('输入姓名搜索同事...');
    if (await remoteSearch.count()) await remoteSearch.fill('陈');

    const textarea = page.locator('textarea').first();
    if (await textarea.count()) await textarea.fill('phase 3 display observation');
    await page.waitForTimeout(500);

    // No submit action is performed: the real system is used only to quantify
    // browser-visible mutation volume and request-consumption evidence.
    return await finishDisplayMeasurement(page, requests);
  } finally {
    await context.close();
  }
}

async function installDisplayMeasurement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const valueSelector = [
      'input', 'textarea', 'select', '[contenteditable="true"]',
      '[role="slider"]', '[role="switch"]', '[role="checkbox"]', '[role="radio"]',
    ].join(',');
    const visible = (element: Element): boolean => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const displayCandidates = (): Element[] => [...document.body.querySelectorAll('*')]
      .filter((element) => !element.matches(`script,style,${valueSelector}`))
      .filter(visible)
      .filter((element) => Boolean(element.textContent?.trim()));
    const sanitize = (value: string): string => value
      .replace(/bearer\s+[a-z0-9._~-]+/gi, '<redacted>')
      .replace(/[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, '<redacted>')
      .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '<redacted>')
      .replace(/(password|passwd|token|secret)\s*[:=]\s*\S+/gi, '$1=<redacted>');
    const changed = new Map<Element, { raw: string; sanitized: string }>();
    const state = {
      initialValueCarriers: document.querySelectorAll(valueSelector).length,
      initialDisplayCandidates: displayCandidates().length,
      observerCallbacks: 0,
      observerCallbackTotalMs: 0,
      observerCallbackMaxMs: 0,
      changed,
      valueSelector,
      displayCandidates,
    };
    const observer = new MutationObserver((records) => {
      const startedAt = performance.now();
      state.observerCallbacks += 1;
      for (const record of records) {
        const target = record.target.nodeType === Node.ELEMENT_NODE
          ? record.target as Element
          : record.target.parentElement;
        if (!target || target.matches(valueSelector)) continue;
        const raw = target.textContent?.trim() ?? '';
        if (raw) changed.set(target, { raw, sanitized: sanitize(raw) });
      }
      const duration = performance.now() - startedAt;
      state.observerCallbackTotalMs += duration;
      state.observerCallbackMaxMs = Math.max(state.observerCallbackMaxMs, duration);
    });
    observer.observe(document.body, { childList: true, characterData: true, subtree: true });
    Reflect.set(window, '__phase3DisplayMeasurement', { state, observer });
  });
}

async function finishDisplayMeasurement(
  page: Page,
  requestPayloads: string[],
): Promise<DisplayMeasurement> {
  return page.evaluate((payloads) => {
    const measurement = Reflect.get(window, '__phase3DisplayMeasurement') as {
      state: {
        initialValueCarriers: number;
        initialDisplayCandidates: number;
        observerCallbacks: number;
        observerCallbackTotalMs: number;
        observerCallbackMaxMs: number;
        changed: Map<Element, { raw: string; sanitized: string }>;
        valueSelector: string;
        displayCandidates: () => Element[];
      };
      observer: MutationObserver;
    };
    measurement.observer.disconnect();
    const values = [...measurement.state.changed.values()];
    const encoder = new TextEncoder();
    return {
      initialValueCarriers: measurement.state.initialValueCarriers,
      finalValueCarriers: document.querySelectorAll(measurement.state.valueSelector).length,
      initialDisplayCandidates: measurement.state.initialDisplayCandidates,
      finalDisplayCandidates: measurement.state.displayCandidates().length,
      observerCallbacks: measurement.state.observerCallbacks,
      observerCallbackTotalMs: Number(measurement.state.observerCallbackTotalMs.toFixed(3)),
      observerCallbackMaxMs: Number(measurement.state.observerCallbackMaxMs.toFixed(3)),
      changedDisplayElements: values.length,
      changedTextBytes: encoder.encode(JSON.stringify(values.map((item) => item.raw))).byteLength,
      sanitizedTextBytes: encoder.encode(JSON.stringify(values.map((item) => item.sanitized))).byteLength,
      requestConsumedDisplayValues: values.filter((item) => item.raw.length >= 2
        && payloads.some((payload) => payload.includes(item.raw))).length,
    };
  }, requestPayloads);
}
