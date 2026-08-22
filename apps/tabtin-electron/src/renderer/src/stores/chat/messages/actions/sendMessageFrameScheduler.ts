/**
 * Page Visibility aware scheduling (Fix-21).
 * When the browser tab is hidden, rAF callbacks are paused/throttled.
 * Fall back to setTimeout(0) so streaming chunks still flush periodically.
 */

let _isBackgrounded = false

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    _isBackgrounded = document.hidden
  })
}

export function scheduleFrame(callback: () => void): number {
  if (_isBackgrounded) {
    return setTimeout(callback, 0) as unknown as number
  }
  return requestAnimationFrame(callback)
}

export function cancelFrame(id: number): void {
  cancelAnimationFrame(id)
  clearTimeout(id)
}
