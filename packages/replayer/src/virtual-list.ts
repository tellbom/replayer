import { LocatorNotFoundError } from '@dsh/core';
import type { Locator, Page } from 'playwright';

export interface VirtualItemSpec {
  container: string;
  item: string;
  text: string;
  search?: string;
  maxSegments?: number;
}

export async function resolveVirtualItem(page: Page, spec: VirtualItemSpec): Promise<Locator> {
  const item = (): Locator => page.locator(spec.item).filter({ hasText: spec.text }).first();
  if (spec.search) {
    await page.locator(spec.search).fill(spec.text);
    await item().waitFor({ state: 'visible' });
    return item();
  }

  const container = page.locator(spec.container);
  for (let segment = 0; segment < (spec.maxSegments ?? 100); segment += 1) {
    if ((await item().count()) > 0 && (await item().isVisible())) return item();
    const moved = await container.evaluate((element) => {
      const before = element.scrollTop;
      element.scrollTop = Math.min(element.scrollHeight, before + element.clientHeight);
      element.dispatchEvent(new Event('scroll'));
      return element.scrollTop > before;
    });
    if (!moved) break;
  }
  throw new LocatorNotFoundError(`虚拟列表未找到: ${spec.text}`);
}
