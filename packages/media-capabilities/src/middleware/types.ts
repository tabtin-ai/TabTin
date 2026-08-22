import type { CapabilityResult, ExecutionContext } from '../types.js';

/**
 * Middleware for cross-cutting concerns (billing, rate-limiting, audit, retry).
 *
 * Inspired by Vercel AI SDK's wrapImageModel / wrapLanguageModel pattern.
 * Middleware wraps capability functions without modifying them — each capability
 * stays pure (only its own business logic), and shared concerns are composed externally.
 *
 * Middleware is applied in order: first declared = outermost wrapper
 * (handles params first, sees result last).
 */
export interface CapabilityMiddleware {
  /** Unique identifier for debugging/logging */
  readonly name: string;

  /**
   * Transform input parameters before execution.
   * Use for: parameter validation, default injection, sanitization.
   */
  transformParams?(params: unknown, meta: MiddlewareMeta): Promise<unknown>;

  /**
   * Wrap the execution — can add retry, billing, timing, logging around the call.
   * Must call `doExecute()` exactly once (or zero times to short-circuit).
   */
  wrapExecute?(options: WrapExecuteOptions): Promise<CapabilityResult>;
}

export interface MiddlewareMeta {
  capabilityId: string;
  ctx: ExecutionContext;
}

export interface WrapExecuteOptions {
  doExecute: () => Promise<CapabilityResult>;
  params: unknown;
  capabilityId: string;
  ctx: ExecutionContext;
}
