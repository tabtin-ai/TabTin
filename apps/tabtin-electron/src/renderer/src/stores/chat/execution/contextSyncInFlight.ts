const inFlightBySessionId = new Map<string, Promise<void>>()

export function registerInFlightContextSync(sessionId: string, promise: Promise<void>): void {
  const tracked = promise.finally(() => {
    if (inFlightBySessionId.get(sessionId) === tracked) {
      inFlightBySessionId.delete(sessionId)
    }
  })
  inFlightBySessionId.set(sessionId, tracked)
}

export function awaitInFlightContextSync(sessionId: string): Promise<void> {
  return inFlightBySessionId.get(sessionId) ?? Promise.resolve()
}
