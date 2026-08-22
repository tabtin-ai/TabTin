/**
 * Re-export from @tabtin/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/operations/keyboard-utils.ts
 */
export {
  splitKeyCombo,
  normalizeModifier,
  buildKeyDescriptor,
} from '@tabtin/browser-core';
export type { KeyDescriptor } from '@tabtin/browser-core';
