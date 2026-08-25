import { SkillSchema } from '@dsh/core';
import type { RunResult, Skill } from '@dsh/core';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import { finishVerification, prepareVerification } from './verification.js';

const successfulRun: RunResult = {
  ok: true,
  skillId: 'verification-test',
  steps: [],
  extracted: {},
  reentryCount: 0,
};

describe('T-81 LOW supervised verification', () => {
  it('V1: all-HIGH skill has no LOW verification flow', async () => {
    const fixture = await skillFixture('HIGH', true);
    const prompter = prompts(true, true);
    const session = await prepareVerification(fixture.skill, fixture.path, prompter);

    expect(session).toMatchObject({ proceed: true, supervised: false });
    expect(prompter.confirmSupervised).not.toHaveBeenCalled();
  });

  it('V2/V4: declining supervision executes nothing and leaves draft state', async () => {
    const fixture = await skillFixture('LOW', true);
    const prompter = prompts(false, true);
    const session = await prepareVerification(fixture.skill, fixture.path, prompter);

    expect(session).toMatchObject({ proceed: false, supervised: false });
    expect(fixture.skill.verification.status).toBe('draft');
    expect(prompter.confirmComplete).not.toHaveBeenCalled();
  });

  it('V3: a successful supervised run and explicit acceptance persist verified state', async () => {
    const fixture = await skillFixture('LOW', true);
    const prompter = prompts(true, true);
    const session = await prepareVerification(fixture.skill, fixture.path, prompter);
    await finishVerification(fixture.skill, fixture.path, session, successfulRun, prompter);

    const persisted = parse(await readFile(fixture.path, 'utf8')) as { verification: Skill['verification'] };
    expect(persisted.verification.status).toBe('verified');
    expect(persisted.verification.requiresFirstRunVerification).toBe(false);
    expect(persisted.verification.verifiedAt).toEqual(expect.any(String));
    expect(persisted.verification.verifiedRunId).toEqual(expect.any(String));
  });

  it('V4: rejecting the complete-run result persists draft state', async () => {
    const fixture = await skillFixture('LOW', true);
    const prompter = prompts(true, false);
    const session = await prepareVerification(fixture.skill, fixture.path, prompter);
    await finishVerification(fixture.skill, fixture.path, session, successfulRun, prompter);

    expect(fixture.skill.verification.status).toBe('draft');
    expect(fixture.skill.verification.verifiedRunId).toBeNull();
  });

  it('V5: verified LOW skill does not ask for first-run verification again', async () => {
    const fixture = await skillFixture('LOW', false);
    fixture.skill.verification.status = 'verified';
    fixture.skill.verification.verifiedAt = new Date().toISOString();
    fixture.skill.verification.verifiedRunId = 'run-1';
    const prompter = prompts(true, true);
    const session = await prepareVerification(fixture.skill, fixture.path, prompter);

    expect(session).toMatchObject({ proceed: true, supervised: false });
    expect(prompter.confirmSupervised).not.toHaveBeenCalled();
  });
});

async function skillFixture(
  confidence: 'HIGH' | 'LOW',
  requiresFirstRunVerification: boolean,
): Promise<{ path: string; skill: Skill }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-t81-'));
  const path = join(directory, 'skill.yaml');
  const source = `# retained comment
skill:
  id: verification-test
  name: verification test
  system: test
  baseUrl: http://test
  entry: test
params: []
steps:
  - id: submit
    desc: submit form
    channel: ui
    ui:
      action: click
      target: { strategy: playwright, selector: "button", confidence: ${confidence} }
      recordedHint:
        action: click
        visibleText: Submit
        visibleTextSource: accessible-name
        controlSemantics: null
        tagName: button
        role: button
        matchCountAtRecord: 1
verification:
  status: draft
  requiresFirstRunVerification: ${requiresFirstRunVerification}
`;
  await writeFile(path, source, 'utf8');
  return { path, skill: SkillSchema.parse(parse(source)) };
}

function prompts(supervised: boolean, complete: boolean) {
  return {
    confirmSupervised: vi.fn(async () => supervised),
    confirmComplete: vi.fn(async () => complete),
  };
}
