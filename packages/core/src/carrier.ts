import type { LocatorStrategy } from './types.js';

export interface ValueCarrier {
  via: 'network-body' | 'network-header' | 'network-url'
    | 'ui-fill' | 'ui-select' | 'ui-check' | 'ui-upload' | 'page-derived';
  requestStepId?: string;
  targetLocator?: LocatorStrategy;
}
