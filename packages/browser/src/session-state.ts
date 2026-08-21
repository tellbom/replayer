import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface SessionState {
  entryId: string;
  pid: number;
  endpoint: string;
  profileDir: string;
  status: 'starting' | 'active' | 'invalid';
  identityDigest?: string;
  lastProbeAt?: string;
  pageUrl?: string;
}

export function sessionStatePath(stateDir: string, entryId: string): string {
  return join(stateDir, `session-${entryId}.json`);
}

export async function readLiveSession(
  stateDir: string,
  entryId: string,
): Promise<SessionState | null> {
  let state: SessionState;
  try {
    state = JSON.parse(await readFile(sessionStatePath(stateDir, entryId), 'utf8')) as SessionState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    process.kill(state.pid, 0);
    return state;
  } catch {
    return null;
  }
}
