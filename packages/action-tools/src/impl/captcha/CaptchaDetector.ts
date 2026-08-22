/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/captcha/CaptchaDetector.ts
 */
export {
  buildDetectionScript,
  analyzeDetectionResult,
} from '@tabtin/browser-core';
export type {
  CaptchaInfo,
  CaptchaType,
  CaptchaSuggestedAction,
} from '@tabtin/browser-core';
