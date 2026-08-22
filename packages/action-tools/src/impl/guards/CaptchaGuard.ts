/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/guards/CaptchaGuard.ts
 */
export {
  CaptchaGuard,
  getSharedCaptchaGuard,
} from '@tabtin/browser-core';
export type { CaptchaUserInterventionCallback } from '@tabtin/browser-core';

export type ViewGetter = (tabId: string) => any;
