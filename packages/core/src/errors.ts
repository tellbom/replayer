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

export class SemanticDriftError extends DSHError {
  readonly code = 'SEMANTIC_DRIFT';

  constructor(
    readonly stepId: string,
    readonly recordedText: string,
    readonly currentText: string,
  ) {
    super(
      `步骤 ${stepId}：录制时此处为「${recordedText}」，当前为「${currentText}」。` +
      '该位置型定位已发生语义漂移；为避免错误业务操作，执行已停止，请重新录制。',
    );
  }
}

export class SkillNeedsRerecordError extends DSHError {
  readonly code = 'SKILL_NEEDS_RERECORD';
}

export class ScopeNotReadyError extends DSHError {
  readonly code = 'SCOPE_NOT_READY';
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

/** 【v2.0 C21】认证恢复后身份不一致 */
export class IdentityChangedError extends DSHError {
  readonly code = 'IDENTITY_CHANGED';
}

/** 【v2.0 C17】技能中检测到明文凭证或凭证换取语义 */
export class SchemaViolationError extends DSHError {
  readonly code = 'SCHEMA_VIOLATION';
}

/** 【v2.0 C18】bearer 会话无法就地取用 Authorization 头 */
export class BearerUnavailableError extends DSHError {
  readonly code = 'BEARER_UNAVAILABLE';
}
