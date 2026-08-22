/**
 * Seq-gap tracking state for stream message handler.
 *
 * Extracted as a standalone module so that both the main dispatcher
 * and sub-handlers (e.g. lifecycleHandler) can access the shared
 * state without circular runtime imports.
 */

const syncTimerBySession = new Map<string, ReturnType<typeof setTimeout>>()

export function scheduleSeqGapSync(
  sessionId: string,
  syncFn: () => void,
  delayMs = 2000,
): void {
  const prevTimer = syncTimerBySession.get(sessionId)
  if (prevTimer !== undefined) clearTimeout(prevTimer)
  syncTimerBySession.set(
    sessionId,
    setTimeout(() => {
      syncTimerBySession.delete(sessionId)
      syncFn()
    }, delayMs),
  )
}

export function cleanup(sessionId: string): void {
  const timer = syncTimerBySession.get(sessionId)
  if (timer !== undefined) {
    clearTimeout(timer)
    syncTimerBySession.delete(sessionId)
  }
}

/**
 * Clean up seq tracker and return whether there was a pending sync timer.
 * When true, the caller should trigger an immediate message re-sync.
 */
export function cleanupWithPendingSyncCheck(sessionId: string): boolean {
  const timer = syncTimerBySession.get(sessionId)
  if (timer !== undefined) {
    clearTimeout(timer)
    syncTimerBySession.delete(sessionId)
    return true
  }
  return false
}
