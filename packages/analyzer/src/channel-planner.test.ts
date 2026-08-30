import type { ParamDefinition } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { assertPlannedCarriers } from './channel-planner.js';

describe('channel planner invariants', () => {
  it('rejects a parameter without a primary carrier', () => {
    expect(() => assertPlannedCarriers([param({ carrier: undefined })])).toThrow(/primary carrier/);
  });

  it('rejects a recovery carrier that duplicates the primary carrier', () => {
    const carrier = { via: 'network-body' as const, requestStepId: 's1' };
    expect(() => assertPlannedCarriers([param({ carrier, recoveryCarrier: carrier })]))
      .toThrow(/duplicate carrier/);
  });

  it('requires network carriers to identify their owning request step', () => {
    expect(() => assertPlannedCarriers([param({ carrier: { via: 'network-body' } })]))
      .toThrow(/request step/);
  });

  it('requires UI carriers to identify the standard locator they operate', () => {
    expect(() => assertPlannedCarriers([param({ carrier: { via: 'ui-fill' } })]))
      .toThrow(/target locator/);
  });

  it('allows recovery only as an explicit UI alternative to a network primary', () => {
    expect(() => assertPlannedCarriers([param({
      carrier: {
        via: 'ui-fill',
        targetLocator: { strategy: 'playwright', selector: '#value', confidence: 'HIGH' },
      },
      recoveryCarrier: {
        via: 'ui-check',
        targetLocator: { strategy: 'playwright', selector: '#value', confidence: 'HIGH' },
      },
    })])).toThrow(/network primary/);
  });
});

function param(overrides: Partial<ParamDefinition>): ParamDefinition {
  return {
    name: 'value', type: 'string', required: true,
    lineage: {
      source: { kind: 'user-input', actionIdx: 0 },
      representation: { wire: 'string', hasDisplayValue: false },
      cardinality: 'single', identity: { controlKey: 'name:value', displayName: 'Value' },
    },
    carrier: { via: 'network-body', requestStepId: 's1' },
    ...overrides,
  } as ParamDefinition;
}
