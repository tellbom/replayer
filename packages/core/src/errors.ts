export abstract class DSHError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class LocatorNotFoundError extends DSHError {
  readonly code = 'LOCATOR_NOT_FOUND';
}

export class LoginTimeoutError extends DSHError {
  readonly code = 'LOGIN_TIMEOUT';
}

export class AssertionFailedError extends DSHError {
  readonly code = 'ASSERTION_FAILED';
}

export class LLMValidationError extends DSHError {
  readonly code = 'LLM_VALIDATION_FAILED';
}

export class StepExecutionError extends DSHError {
  readonly code = 'STEP_EXECUTION_FAILED';
}

export class OutcomeUnknownError extends DSHError {
  readonly code = 'OUTCOME_UNKNOWN';
}

export class ForbiddenError extends DSHError {
  readonly code = 'FORBIDDEN';
}

export class NoMatchingSkillError extends DSHError {
  readonly code = 'NO_MATCHING_SKILL';
}

export class TokenBudgetExceededError extends DSHError {
  readonly code = 'TOKEN_BUDGET_EXCEEDED';
}
