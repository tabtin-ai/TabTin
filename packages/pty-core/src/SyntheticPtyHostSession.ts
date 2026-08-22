import type {
  PtyHostDisposable,
  PtyHostExitEvent,
  PtyHostSession,
  PtyHostSpawnedEvent,
} from './PtyHost'

/**
 * A no-op PTY host used for agent transcript sessions.
 *
 * The command itself runs as a regular child process; the "terminal session"
 * is only a transcript surface for UI/readback. Keeping this in pty-core lets
 * Electron and Daemon share the same inert PTY implementation.
 */
export class SyntheticPtyHostSession implements PtyHostSession {
  readonly pid = 0
  private exited = false
  private readonly exitHandlers = new Set<(event: PtyHostExitEvent) => void>()

  write(_data: string): void {
    // Transcript sessions are output-only.
  }

  resize(_cols: number, _rows: number): void {
    // No backing terminal to resize.
  }

  kill(_signal?: string): void {
    if (this.exited) return
    this.exited = true
    queueMicrotask(() => {
      for (const handler of Array.from(this.exitHandlers)) {
        handler({ exitCode: null })
      }
      this.exitHandlers.clear()
    })
  }

  pauseOutput(): void {
    // No backing output stream.
  }

  resumeOutput(): void {
    // No backing output stream.
  }

  onSpawned(handler: (event: PtyHostSpawnedEvent) => void): PtyHostDisposable {
    queueMicrotask(() => handler({ pid: this.pid }))
    return { dispose: () => {} }
  }

  onData(_handler: (data: string) => void): PtyHostDisposable {
    return { dispose: () => {} }
  }

  onExit(handler: (event: PtyHostExitEvent) => void): PtyHostDisposable {
    this.exitHandlers.add(handler)
    return {
      dispose: () => {
        this.exitHandlers.delete(handler)
      },
    }
  }
}
