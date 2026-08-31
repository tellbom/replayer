import type { CanonicalAction, LocatorStrategy, ObservableState, RecordSession } from '@dsh/core';

export interface TestEvent {
  ts: number;
  type: 'click' | 'fill' | 'select' | 'radio' | 'checkbox' | 'datetime' | 'navigate';
  target?: LocatorStrategy;
  label?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  text?: string;
  url?: string;
  enumOptions?: CanonicalAction['enumOptions'];
  effects?: CanonicalAction['effects'];
  before?: ObservableState;
  affected?: NonNullable<ObservableState['affected']>;
  affectedTruncated?: boolean;
  tag?: string;
  role?: string;
  inputType?: string;
  placeholder?: string;
}

export type MutableTestSession = Omit<RecordSession, 'canonicalActions'> & {
  events: TestEvent[];
  canonicalActions: CanonicalAction[];
};

export function testSession(
  input: Omit<RecordSession, 'canonicalActions'> & { events?: TestEvent[] },
): MutableTestSession {
  const events = input.events ?? [];
  const session = { ...input, events } as MutableTestSession;
  Object.defineProperty(session, 'canonicalActions', {
    enumerable: true,
    configurable: false,
    get: () => session.events.map(toCanonicalAction),
  });
  return session;
}

function toCanonicalAction(event: TestEvent, actionIdx: number): CanonicalAction {
  const locatorEvidence = event.target ? targetEvidence(event.target) : undefined;
  const kind = event.type === 'click' ? 'activate'
    : event.type === 'fill' || event.type === 'datetime' ? 'edit'
      : event.type === 'select' ? 'select'
        : event.type === 'radio' || event.type === 'checkbox' ? 'check' : 'navigate';
  return {
    id: `test-${actionIdx}`,
    actionIdx,
    timestamp: event.ts,
    kind,
    ...((event.label || event.name || locatorEvidence || event.tag || event.role) ? {
      target: {
        ...(event.tag ? { tag: event.tag } : {}),
        ...(event.role ? { role: event.role } : {}),
        ...(event.inputType ? { inputType: event.inputType } : {}),
        ...(event.placeholder ? { placeholder: event.placeholder } : {}),
        ...(event.label ? { accessibleName: event.label } : {}),
        ...(event.name ? { name: event.name } : {}),
        ...(event.type === 'radio' ? { role: 'radio', inputType: 'radio' } : {}),
        ...(event.type === 'checkbox' ? { role: 'checkbox', inputType: 'checkbox' } : {}),
        ...(locatorEvidence ? { locatorEvidence } : {}),
      },
    } : {}),
    ...(event.before ? { before: event.before } : {}),
    ...((event.value !== undefined || event.checked !== undefined || event.text
      || event.affected || event.affectedTruncated !== undefined) ? {
      after: {
        self: {
          ...(event.value !== undefined ? { value: event.value } : {}),
          ...(event.checked !== undefined ? { checked: event.checked } : {}),
          ...(event.text ? { textContent: event.text } : {}),
        },
        ...(event.affected ? { affected: event.affected } : {}),
        ...(event.affectedTruncated !== undefined
          ? { affectedTruncated: event.affectedTruncated }
          : {}),
        ...(event.url ? { page: { url: event.url } } : {}),
      },
    } : event.url ? { after: { page: { url: event.url } } } : {}),
    ...(event.type === 'navigate' && event.url
      ? { effects: { navigation: { url: event.url } } }
      : {}),
    ...(event.enumOptions ? { enumOptions: event.enumOptions } : {}),
    ...(event.effects ? { effects: event.effects } : {}),
    raw: { eventTypes: [event.type], trusted: true },
    source: 'playwright-probe',
  };
}

function targetEvidence(target: LocatorStrategy): NonNullable<CanonicalAction['target']>['locatorEvidence'] {
  if (target.strategy === 'playwright' || target.strategy === 'frame-playwright') {
    return {
      generatedSelector: target.selector,
      confidence: target.confidence ?? 'HIGH',
    };
  }
  if (target.strategy === 'css') {
    return { generatedSelector: target.selector, confidence: 'HIGH' };
  }
  if (target.strategy === 'role') {
    return {
      generatedSelector: `internal:role=${target.role}[name="${target.name}"i]`,
      confidence: 'HIGH',
    };
  }
  if (target.strategy === 'label') {
    return {
      generatedSelector: `internal:label="${target.label}"i`,
      confidence: 'HIGH',
    };
  }
  return {
    generatedSelector: `internal:text="${target.text}"${target.exact === false ? 'i' : 's'}`,
    confidence: target.nth === undefined ? 'HIGH' : 'LOW',
  };
}
