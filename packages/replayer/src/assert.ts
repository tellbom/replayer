import { isDeepStrictEqual } from 'node:util';

import { AssertionFailedError } from '@dsh/core';
import type { ExecContext, Skill, StepResult } from '@dsh/core';

type Assertion = Skill['assertions'][number];

/** Validate deterministic assertions against one response and update extracted variables. */
export function runAssertions(
  assertions: readonly Assertion[],
  response: StepResult['raw'],
  context: ExecContext,
): void {
  for (const assertion of assertions) runAssertion(assertion, response, context);
}

function runAssertion(
  assertion: Assertion,
  response: StepResult['raw'],
  context: ExecContext,
): void {
  if (assertion.type === 'httpStatus') {
    if (!isDeepStrictEqual(response?.status, assertion.expect)) fail(assertion, response?.status);
    return;
  }

  const text = response?.text;
  if (text === undefined) fail(assertion, undefined);

  if (assertion.type === 'textPresent') {
    if (!text.includes(String(assertion.expect))) fail(assertion, text);
    return;
  }

  if (assertion.type === 'jsonPath') {
    if (!assertion.path) fail(assertion, 'missing path');
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new AssertionFailedError('jsonPath assertion response is not JSON', { cause: error });
    }
    const actual = readJsonPath(body, assertion.path);
    if (!isDeepStrictEqual(actual, assertion.expect)) fail(assertion, actual);
    return;
  }

  if (!assertion.pattern || !assertion.name) fail(assertion, 'missing pattern or name');
  let match: RegExpMatchArray | null;
  try {
    match = text.match(new RegExp(assertion.pattern));
  } catch (error) {
    throw new AssertionFailedError(`regexExtract pattern is invalid: ${assertion.pattern}`, {
      cause: error,
    });
  }
  if (!match?.[1]) fail(assertion, text);
  context.vars[assertion.name] = match[1];
}

function readJsonPath(value: unknown, path: string): unknown {
  const segments = path
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null || !(segment in current)) {
      throw new AssertionFailedError(`jsonPath assertion path not found: ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function fail(assertion: Assertion, actual: unknown): never {
  throw new AssertionFailedError(
    `${assertion.type} assertion failed; expected=${JSON.stringify(assertion.expect)}; actual=${JSON.stringify(actual)}`,
  );
}
