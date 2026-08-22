/**
 * Power management facade — wraps window.tabtin.power IPC calls.
 *
 * Centralises preventSleep / allowSleep so callers don't need to
 * repeat the optional-chaining + catch boilerplate.
 */

export function preventSleep(): void {
  window.tabtin?.power?.preventSleep?.()?.catch?.(() => {})
}

export function allowSleep(): void {
  window.tabtin?.power?.allowSleep?.()?.catch?.(() => {})
}
