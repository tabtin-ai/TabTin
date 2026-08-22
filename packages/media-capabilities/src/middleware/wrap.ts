import type { CapabilityFn, CapabilityResult, ExecutionContext } from '../types.js';
import type { CapabilityMiddleware } from './types.js';

/**
 * Wrap a capability function with one or more middleware layers.
 *
 * Middleware is applied in declaration order:
 * - transformParams: first middleware transforms first
 * - wrapExecute: first middleware is the outermost wrapper (runs first, sees result last)
 *
 * Usage:
 * ```ts
 * const generateImageSafe = withMiddleware('image.generate', generateImage, [
 *   billingMiddleware,
 *   rateLimitMiddleware,
 *   auditMiddleware,
 * ]);
 * ```
 */
export function withMiddleware<TInput, TData>(
  capabilityId: string,
  fn: CapabilityFn<TInput, TData>,
  middleware: CapabilityMiddleware | CapabilityMiddleware[],
): CapabilityFn<TInput, TData> {
  const layers = Array.isArray(middleware) ? middleware : [middleware];

  if (layers.length === 0) return fn;

  return async (input: TInput, ctx: ExecutionContext): Promise<CapabilityResult<TData>> => {
    let params: unknown = input;

    for (const mw of layers) {
      if (mw.transformParams) {
        params = await mw.transformParams(params, { capabilityId, ctx });
      }
    }

    let execute: () => Promise<CapabilityResult> = () =>
      fn(params as TInput, ctx) as Promise<CapabilityResult>;

    for (const mw of [...layers].reverse()) {
      if (mw.wrapExecute) {
        const currentExecute = execute;
        const currentMw = mw;
        execute = () =>
          currentMw.wrapExecute!({
            doExecute: currentExecute,
            params,
            capabilityId,
            ctx,
          });
      }
    }

    return execute() as Promise<CapabilityResult<TData>>;
  };
}
