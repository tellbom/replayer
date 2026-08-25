import type { RecordSession } from '@dsh/core';

export interface PreflightDraft {
  name: string;
  request?: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string> };
  extract:
    | { type: 'dom'; selector: string; attribute: string }
    | { type: 'jsonPath'; path: string }
    | { type: 'regex'; pattern: string; group: number };
}

export interface AuthDraft {
  probeUrl: string;
  sessionApi?: string;
  loggedInJsonPath?: string;
  loginUrlPatterns: string[];
  loginDomMarkers?: string[];
  loginTimeoutMs: number;
}

export interface AuthDetection {
  auth?: AuthDraft;
  forbiddenUrls: string[];
}

/**
 * A global preflight changes the recorded navigation order. The analyzer therefore never invents
 * one from field names or literal shapes. Page-instance values are attached to their recorded
 * navigation step; explicitly authored skills may still use the frozen preflight contract.
 */
export function detectPreflight(session: RecordSession): PreflightDraft[] {
  void session;
  return [];
}

/** Authentication is configured explicitly by Entry probes and is never inferred from endpoints. */
export function detectAuth(session: RecordSession): AuthDetection {
  return {
    forbiddenUrls: session.network
      .filter((request) => request.status === 403)
      .map((request) => request.url),
  };
}
