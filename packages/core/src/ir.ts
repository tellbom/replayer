import type { LocatorStrategy } from './types.js';

export interface CanonicalAction {
  id: string;
  actionIdx: number;
  timestamp: number;
  kind: 'activate' | 'edit' | 'select' | 'check' | 'key' | 'upload' | 'navigate' | 'unknown';
  target?: SemanticTarget;
  before?: ObservableState;
  after?: ObservableState;
  effects?: {
    domMutations?: DomEffect[];
    requestIds?: string[];
    navigation?: NavigationEffect;
  };
  raw: {
    eventTypes: string[];
    trusted: boolean;
    unclassifiedReason?: string;
  };
  source: 'playwright-probe';
}

export interface SemanticTarget {
  tag?: string;
  role?: string;
  accessibleName?: string;
  name?: string;
  inputType?: string;
  placeholder?: string;
  locatorEvidence?: {
    generatedSelector: string;
    confidence: 'HIGH' | 'LOW';
    cssCandidates?: string[];
  };
  neighborhood?: {
    ancestorRoles?: string[];
    labelText?: string;
    formScope?: string;
  };
}

export interface ObservableState {
  self?: ElementState;
  affected?: Array<{
    locator: LocatorStrategy;
    state: ElementState;
  }>;
  affectedTruncated?: boolean;
  page?: {
    url: string;
    focusedLocator?: LocatorStrategy;
  };
}

export interface ElementState {
  value?: string | string[] | null;
  checked?: boolean;
  selected?: boolean;
  textContent?: string;
  innerHTML?: string;
  innerHTMLTruncated?: boolean;
  files?: Array<{ name: string; size: number; type: string }>;
  aria?: Record<string, string>;
  disabled?: boolean;
  readonly?: boolean;
}

export interface DomEffect {
  locator: LocatorStrategy;
  before?: ElementState;
  after?: ElementState;
}

export interface NavigationEffect {
  url: string;
  previousUrl?: string;
}
