import { parseSkill } from '@dsh/core';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { replay } from './engine.js';

describe('replay dry-run', () => {
  it('prints the complete plan without launching a browser or creating a profile', async () => {
    const profileDir = join(process.cwd(), 'profiles', 'dry-run-must-not-exist');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const skill = parseSkill(`
skill:
  id: overtime_submit
  name: 提交加班
  system: mock-oa
  baseUrl: http://127.0.0.1:5173
params: []
preflight:
  - name: csrfToken
    extract: { type: dom, selector: 'meta[name="csrf-token"]', attribute: content }
steps:
  - id: s1
    desc: 提交
    channel: network
    riskLevel: write
    hasSideEffect: true
    network: { method: POST, url: /api/overtime/submit, contentType: json }
assertions:
  - { type: httpStatus, expect: 200 }
postcondition:
  request: { method: GET, url: /api/overtime/history?limit=5 }
  match: { jsonPath: '$.list[*]', where: {} }
`);

    const result = await replay(skill, {
      params: {},
      profileDir,
      dryRun: true,
      noLLM: true,
    });
    const plan = output.mock.calls.map(([text]) => String(text)).join('');
    output.mockRestore();

    expect(result).toEqual({ ok: true, skillId: 'overtime_submit', steps: [], extracted: {} });
    expect(plan).toContain('预取:');
    expect(plan).toContain('csrfToken: dom');
    expect(plan).toContain('s1 [network/write] 提交 [side-effect]');
    expect(plan).toContain('断言:');
    expect(plan).toContain('postcondition: /api/overtime/history?limit=5');
    expect(existsSync(profileDir)).toBe(false);
  });
});
