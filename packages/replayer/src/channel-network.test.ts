import type { ExecContext, Step } from '@dsh/core';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { executeNetworkStep } from './channel-network.js';

describe('executeNetworkStep', () => {
  it('classifies a missing template variable as not_sent before page access', async () => {
    const step: Step = {
      id: 's1',
      desc: '缺失模板',
      channel: 'network',
      riskLevel: 'write',
      hasSideEffect: true,
      network: {
        method: 'POST',
        url: '/api/submit',
        contentType: 'json',
        body: { reason: '{{missing}}' },
      },
    };
    const context: ExecContext = { params: {}, vars: {}, stepResults: {}, baseUrl: 'http://oa' };
    const result = await executeNetworkStep({} as Page, step, context, []);
    expect(result.outcome).toBe('not_sent');
  });
});
