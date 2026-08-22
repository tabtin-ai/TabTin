/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/operations/ActionRunner.ts
 */
export {
  runSingleAction,
  runActionSequence,
  buildFailureEntry,
} from '@tabtin/browser-core';
export type {
  ActionEntry,
  ActionSequenceOptions,
  ActionSequenceResult,
} from '@tabtin/browser-core';
