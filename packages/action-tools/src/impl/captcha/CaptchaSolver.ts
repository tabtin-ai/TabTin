/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/captcha/CaptchaSolver.ts
 */
export { NoOpCaptchaSolver } from '@tabtin/browser-core';
export type {
  CaptchaSolver,
  CaptchaSolveParams,
  CaptchaSolveResult,
} from '@tabtin/browser-core';
