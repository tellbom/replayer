import type { CanonicalAction, RecordedRequest } from '@dsh/core';
import { describe, expect, it } from 'vitest';

import { finalizeCanonicalActions } from './canonical.js';

describe('finalizeCanonicalActions', () => {
  it('preserves the complete raw event sequence and attaches request ids by actionIdx', () => {
    const action: CanonicalAction = {
      id: 'a0', actionIdx: 0, timestamp: 1, kind: 'unknown',
      raw: {
        eventTypes: ['pointerdown', 'pointerup', 'click'],
        trusted: true,
        unclassifiedReason: 'no observable state change',
      },
      source: 'playwright-probe',
    };
    const requests: RecordedRequest[] = [
      { requestId: 'r1', actionIdx: 0 } as RecordedRequest,
      { requestId: 'r2', actionIdx: 1 } as RecordedRequest,
    ];

    expect(finalizeCanonicalActions([action], requests)[0]).toMatchObject({
      raw: { eventTypes: ['pointerdown', 'pointerup', 'click'] },
      effects: { requestIds: ['r1'] },
    });
  });
});
