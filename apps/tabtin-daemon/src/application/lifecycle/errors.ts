/**
 * Session-level error types for the runLoop / runSession state machine.
 *
 * FatalSessionError → entire session terminates → runLoop retries with backoff
 * RecoverableRoutineError → individual routine retries locally → session continues
 */

export class FatalSessionError extends Error {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = 'FatalSessionError';
  }
}

export class RecoverableRoutineError extends Error {
  constructor(message: string, options?: { cause?: Error }) {
    super(message, options);
    this.name = 'RecoverableRoutineError';
  }
}
