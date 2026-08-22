/**
 * Sliding window rate limiter for CLI Server routes.
 *
 * Used to throttle heavy operations like code grep.
 * Both Electron and Daemon use the same configuration (20 req / 60s).
 */
export class SlidingWindowRateLimiter {
  private timestamps: number[] = []

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  tryAcquire(): boolean {
    const now = Date.now()
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs)
    if (this.timestamps.length >= this.maxRequests) return false
    this.timestamps.push(now)
    return true
  }
}
