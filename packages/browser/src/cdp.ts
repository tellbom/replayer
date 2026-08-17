import type { CDPSession, Page } from 'playwright';

export interface DSHCDP {
  session: CDPSession;
  enableNetwork(): Promise<void>;
  enableFetch(patterns?: Array<{ urlPattern?: string; requestStage?: 'Request' | 'Response' }>): Promise<void>;
}

export async function attachCDP(page: Page): Promise<DSHCDP> {
  const session = await page.context().newCDPSession(page);
  return {
    session,
    async enableNetwork() {
      await session.send('Network.enable');
    },
    async enableFetch(patterns) {
      await session.send('Fetch.enable', patterns ? { patterns } : undefined);
    },
  };
}
