/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/BrowserToolImpl.ts
 */
export {
  BrowserToolImpl,
  getSharedBrowserToolImpl,
  resetSharedBrowserToolImpl,
} from '@tabtin/browser-core';
export type { CaptchaUserInterventionCallback } from '@tabtin/browser-core';
