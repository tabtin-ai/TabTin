/**
 * Owns host runtime sessions without exposing the backing Map to adapters.
 *
 * Session state remains host-specific; lifecycle and lookup semantics are
 * shared by Electron and Daemon.
 */
export class RuntimeSessionRegistry<State> {
  private readonly sessions = new Map<string, State>()

  get size(): number {
    return this.sessions.size
  }

  get(sessionId: string): State | undefined {
    return this.sessions.get(sessionId)
  }

  set(sessionId: string, state: State): void {
    this.sessions.set(sessionId, state)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  clear(): void {
    this.sessions.clear()
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys()
  }

  values(): IterableIterator<State> {
    return this.sessions.values()
  }

  entries(): IterableIterator<[string, State]> {
    return this.sessions.entries()
  }

  [Symbol.iterator](): IterableIterator<[string, State]> {
    return this.sessions[Symbol.iterator]()
  }
}
