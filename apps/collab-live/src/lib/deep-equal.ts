import * as Y from "yjs";

/**
 * Deep equality comparison for JSON-serializable values.
 * Used by database extensions to detect real changes before persisting.
 *
 * Handles Y.js CRDT types: Y.Map / Y.Array are never considered equal via
 * deep comparison (they are live mutable containers, not plain data).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;

  // CI-002: NaN === NaN is false in JS, but semantically equal for change detection
  if (typeof a === "number" && typeof b === "number") {
    return Number.isNaN(a) && Number.isNaN(b);
  }

  if (a == null || b == null) return a === b;
  if (typeof a !== typeof b) return false;

  if (typeof a === "object") {
    if (a instanceof Y.Map || a instanceof Y.Array) return false;

    // CI-004: Date instances — compare by time value, not by (empty) keys
    if (a instanceof Date || b instanceof Date) {
      return (
        a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
      );
    }

    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!deepEqual(a[i], (b as unknown[])[i])) return false;
      }
      return true;
    }

    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    // CI-003: { a: undefined } ≡ {} in JSON semantics — filter out undefined-valued keys
    const aKeys = Object.keys(aObj).filter((k) => aObj[k] !== undefined);
    const bKeys = Object.keys(bObj).filter((k) => bObj[k] !== undefined);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!deepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }

  return false;
}
