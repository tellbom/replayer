import type { LocatorStrategy } from './types.js';

export interface ValueLineage {
  source: ValueSource;
  representation: ValueRepresentation;
  cardinality: 'single' | 'multiple';
  identity: LineageIdentity;
}

export type ValueSource =
  | { kind: 'user-input'; actionIdx: number }
  | { kind: 'response'; requestId: string; path: string }
  | { kind: 'page-instance'; pageSnapshotId: string; locator: LocatorStrategy }
  | { kind: 'derived'; dependsOn: string[] }
  | { kind: 'environment' }
  | { kind: 'constant' }
  | { kind: 'unresolved'; reason: string };

export interface ValueRepresentation {
  wire: 'string' | 'number' | 'boolean' | 'enum' | 'file' | 'json';
  enumDomain?: {
    map: Record<string, string>;
    contextual: boolean;
    origin: 'dom-options' | 'response' | 'recorded-only';
    complete: boolean;
  };
  hasDisplayValue: boolean;
}

export interface LineageIdentity {
  controlKey?: string;
  displayName?: string;
  groupKey?: string;
}
