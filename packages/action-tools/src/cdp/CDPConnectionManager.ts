/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/cdp/CDPConnectionManager.ts
 */
export {
  CDPConnectionManager,
  CDPConnectionProfile,
  getCDPConnectionManager,
  destroyCDPConnectionManager,
} from '@tabtin/browser-core';
export type {
  CDPConnectionStrategy,
  CDPConnectionConfig,
  TaskLifecycleEvent,
} from '@tabtin/browser-core';
