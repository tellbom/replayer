import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, type BrowserContext } from 'playwright';

export interface BrowserOptions {
  profileDir: string;
  channel?: 'chrome' | 'msedge';
  executablePath?: string;
  headless?: boolean;
  proxy?: { server: string; bypass?: string };
  authServerAllowlist?: string;
  clientCertificates?: Array<{ origin: string; pfxPath: string; passphrase?: string }>;
  timeoutMs?: number;
}

const INIT_SCRIPT_PATHS = [
  '../../locator/dist/el-locator.iife.js',
  '../../locator/dist/snapshot.iife.js',
  '../../locator/dist/selector-generator.iife.js',
] as const;

export async function launchDSHContext(options: BrowserOptions): Promise<BrowserContext> {
  const args = options.authServerAllowlist
    ? [
        `--auth-server-allowlist=${options.authServerAllowlist}`,
        `--auth-negotiate-delegate-allowlist=${options.authServerAllowlist}`,
      ]
    : [];
  const context = await chromium.launchPersistentContext(options.profileDir, {
    channel: options.channel ?? 'chrome',
    executablePath: options.executablePath,
    headless: options.headless ?? false,
    proxy: options.proxy,
    clientCertificates: options.clientCertificates,
    timeout: options.timeoutMs,
    args,
  });

  for (const relativePath of INIT_SCRIPT_PATHS) {
    const path = fileURLToPath(new URL(relativePath, import.meta.url));
    await context.addInitScript({ content: await readFile(path, 'utf8') });
  }
  return context;
}
