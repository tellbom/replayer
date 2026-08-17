import type { ExecContext, Skill } from '@dsh/core';
import type { Page } from 'playwright';
import { describe, expect, it } from 'vitest';

import { executePreflights } from './preflight.js';

describe('executePreflights', () => {
  it('rejects non-DOM extraction without a request before touching the page', async () => {
    const preflights: Skill['preflight'] = [
      { name: 'token', extract: { type: 'jsonPath', path: '$.token' } },
    ];
    const context: ExecContext = { params: {}, vars: {}, stepResults: {}, baseUrl: 'http://oa' };
    await expect(executePreflights({} as Page, preflights, context)).rejects.toThrow(
      /无 request.*DOM/,
    );
  });
});
