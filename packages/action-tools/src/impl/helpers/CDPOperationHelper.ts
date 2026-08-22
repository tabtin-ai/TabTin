/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/operations/CDPOperationHelper.ts
 */
export {
  CDPOperationHelper,
  getSharedCDPOperationHelper,
  isCDPAction,
  isCoordinateClick,
} from '@tabtin/browser-core';
export type {
  CDPActionType,
  CDPActionOptions,
  CDPOperationResult,
} from '@tabtin/browser-core';
