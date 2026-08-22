/**
 * SessionPauseController — cooperative pause gate shared by Electron / Daemon.
 *
 * Pause takes effect at the next safe engine boundary (before an iteration).
 * The in-flight LLM/tool step is allowed to finish; cancel remains the immediate
 * abort path. Resume releases every waiter for this session.
 */
export class SessionPauseController {
  private paused = false
  private waiters = new Set<() => void>()

  get isPaused(): boolean {
    return this.paused
  }

  pause(): boolean {
    if (this.paused) return false
    this.paused = true
    return true
  }

  resume(): boolean {
    if (!this.paused) return false
    this.paused = false
    for (const release of this.waiters) release()
    this.waiters.clear()
    return true
  }

  async waitIfPaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused || signal?.aborted) return
    await new Promise<void>((resolve) => {
      const release = (): void => {
        signal?.removeEventListener('abort', release)
        this.waiters.delete(release)
        resolve()
      }
      this.waiters.add(release)
      signal?.addEventListener('abort', release, { once: true })
      if (!this.paused) release()
    })
  }
}
