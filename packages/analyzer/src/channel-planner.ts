import type { ParamDefinition, ValueCarrier } from '@dsh/core';

export function assertPlannedCarriers(params: readonly ParamDefinition[]): void {
  for (const param of params) {
    if (!param.carrier) throw new Error(`parameter ${param.name} has no primary carrier`);
    assertCarrierAddress(param.name, param.carrier);
    if (param.recoveryCarrier && sameCarrier(param.carrier, param.recoveryCarrier)) {
      throw new Error(`parameter ${param.name} has duplicate carrier`);
    }
    if (param.recoveryCarrier) {
      if (!param.carrier.via.startsWith('network-')) {
        throw new Error(`parameter ${param.name} recovery requires a network primary carrier`);
      }
      if (!param.recoveryCarrier.via.startsWith('ui-')) {
        throw new Error(`parameter ${param.name} recovery carrier must be a UI carrier`);
      }
      assertCarrierAddress(param.name, param.recoveryCarrier);
    }
  }
}

function assertCarrierAddress(name: string, carrier: ValueCarrier): void {
  if (carrier.via.startsWith('network-') && !carrier.requestStepId) {
    throw new Error(`parameter ${name} network carrier has no request step`);
  }
  if ((carrier.via.startsWith('ui-') || carrier.via === 'page-derived') && !carrier.targetLocator) {
    throw new Error(`parameter ${name} ${carrier.via} carrier has no target locator`);
  }
}

function sameCarrier(left: ValueCarrier, right: ValueCarrier): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
