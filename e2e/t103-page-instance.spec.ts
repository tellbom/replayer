import { expect, test } from '@playwright/test';
import { generateDraft } from '@dsh/analyzer';
import { parseEntry } from '@dsh/core';
import { record } from '@dsh/recorder';
import { replay } from '@dsh/replayer';
import { createServer } from 'node:http';

test.setTimeout(120_000);

test('T-103 extracts a consumed page-instance value after navigation on every replay', async ({ browserName }, testInfo) => {
  let generation = 0;
  const stored: Array<{ pageValue: string; payload: string }> = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    if (path === '/form') {
      const pageValue = `instance-${++generation}-${Date.now()}`;
      response.setHeader('content-type', 'text/html');
      response.end(`<!doctype html><input type="hidden" name="pageValue" value="${pageValue}">
        <label>Payload <input id="payload" name="payload"></label><button id="submit">Submit</button>
        <script>document.querySelector('#submit').addEventListener('click', async () => {
          await fetch('/records', { method: 'POST', headers: {'content-type':'application/json'},
            body: JSON.stringify({ pageValue: document.querySelector('[name=pageValue]').value,
              payload: document.querySelector('#payload').value }) });
          document.body.dataset.done = 'yes';
        });</script>`);
      return;
    }
    if (path === '/records' && request.method === 'POST') {
      let body = '';
      request.on('data', (chunk) => { body += String(chunk); });
      request.on('end', () => {
        const submitted = JSON.parse(body) as { pageValue: string; payload: string };
        const expectedPrefix = `instance-${generation}-`;
        if (!submitted.pageValue.startsWith(expectedPrefix)) {
          response.writeHead(409).end('{"ok":false}');
          return;
        }
        stored.push(submitted);
        response.setHeader('content-type', 'application/json');
        response.end('{"ok":true}');
      });
      return;
    }
    if (path === '/probe') return void response.end('{"active":true}');
    if (path === '/identity') return void response.end('{"principal":"fixture-user"}');
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not bind');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const entry = parseEntry(`
entry:
  id: page-instance-fixture
  name: page instance fixture
  via: direct
  directUrl: ${baseUrl}/form
  landingUrlPattern: /form
  sessionType: cookie
  sessionProbe: { url: /probe, okStatus: [200] }
  identityProbe: { url: /identity, jsonPath: $.principal, requiresAuth: true }
  sessionHolding: { strategy: daemon, probeIntervalMs: 30000, stateTtlMs: 1800000 }
`);
  try {
    let stop!: () => void;
    const stopSignal = new Promise<void>((resolve) => { stop = resolve; });
    const session = await record({
      entry,
      profileDir: testInfo.outputPath(`record-profile-${browserName}`),
      outDir: testInfo.outputPath('recording'),
      channel: 'chrome',
      headless: true,
      stopSignal,
      onReady: async (page) => {
        await page.goto(`${baseUrl}/form`);
        await page.locator('#payload').fill('recorded-value');
        await page.locator('#submit').evaluate((element) => (element as HTMLButtonElement).click());
        await expect(page.locator('body')).toHaveAttribute('data-done', 'yes');
        stop();
      },
    });
    expect(session.pageSnapshots?.flatMap((snapshot) => snapshot.immutableValues)).toHaveLength(1);

    const draft = generateDraft(session);
    expect(draft.skill.preflight).toEqual([]);
    const navigation = draft.skill.steps.find((step) => step.ui?.action === 'navigate' && step.ui.extract);
    expect(navigation?.ui?.extract).toEqual(expect.objectContaining({ pageValue: 'input[name="pageValue"]' }));
    expect(draft.skill.steps.find((step) => step.network?.method === 'POST')?.network?.body?.pageValue)
      .toBe('{{pageValue}}');

    const before = stored.length;
    const replayTokens: string[] = [];
    for (const payload of ['runtime-one', 'runtime-two']) {
      const result = await replay(draft.skill, {
        params: { payload },
        profileDir: testInfo.outputPath(`replay-profile-${browserName}`),
        entry,
        noLLM: true,
        onConfirm: async () => true,
      });
      expect(result.ok).toBe(true);
      replayTokens.push(stored.at(-1)!.pageValue);
    }
    expect(stored.length - before).toBe(2);
    expect(new Set(replayTokens).size).toBe(2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
