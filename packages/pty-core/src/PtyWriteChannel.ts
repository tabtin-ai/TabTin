export interface PtyWritable {
  write(data: string): void
}

/**
 * PC-30 fix: reason why the channel was closed, enabling callers
 * (e.g. renderer) to display appropriate feedback.
 */
export type WriteChannelCloseReason = 'disposed' | 'closed' | 'write_error' | 'queue_overflow'

export interface PtyWriteChannelOptions {
  maxQueuedBytes?: number
  onWriteError?: (error: unknown, chunk: string | null) => void
  /**
   * PC-30 fix: called when the channel is closed due to an error or overflow,
   * with the reason for the closure. Callers can use this to notify
   * the user (e.g. prompt to restart the session).
   */
  onClose?: (reason: WriteChannelCloseReason) => void
}

const DEFAULT_MAX_QUEUED_BYTES = 256 * 1024

export class PtyWriteChannel {
  private readonly queue: Array<{ chunk: string; bytes: number }> = []
  private queuedBytes = 0
  private flushing = false
  private closed = false
  private _closedByError = false
  private _closeReason: WriteChannelCloseReason | null = null

  constructor(
    private readonly writable: PtyWritable,
    private readonly options: PtyWriteChannelOptions = {},
  ) {}

  enqueue(chunk: string): boolean {
    if (this.closed) {
      return false
    }

    const bytes = Buffer.byteLength(chunk, 'utf8')
    const maxBytes = this.options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    if (this.queuedBytes + bytes > maxBytes) {
      // PC-30 fix: before closing, try to shed oldest queued writes to make room.
      // This gives a chance to recover from transient bursts without killing the channel.
      const bytesNeeded = (this.queuedBytes + bytes) - maxBytes
      const shed = this.shedOldestBytes(bytesNeeded)
      if (shed && this.queuedBytes + bytes <= maxBytes) {
        // Successfully made room; continue with enqueue
      } else {
        this.handleOverflow(new Error('PTY write queue exceeded max size'), chunk)
        return false
      }
    }

    this.queue.push({ chunk, bytes })
    this.queuedBytes += bytes

    return this.flush()
  }

  close(): void {
    this.closed = true
    if (!this._closeReason) {
      this._closeReason = 'closed'
    }
  }

  dispose(): void {
    this.closed = true
    this._closeReason = 'disposed'
    this.queue.length = 0
    this.queuedBytes = 0
  }

  getQueuedBytes(): number {
    return this.queuedBytes
  }

  isClosed(): boolean {
    return this.closed
  }

  /**
   * Returns true when the channel was closed due to a write error (as opposed
   * to a deliberate dispose/close call). Callers can use this to distinguish
   * expected shutdown from unexpected failure.
   */
  isClosedByError(): boolean {
    return this._closedByError
  }

  /**
   * PC-30 fix: returns the reason the channel was closed, or null if still open.
   */
  get closeReason(): WriteChannelCloseReason | null {
    return this._closeReason
  }

  /**
   * PC-30 fix: attempt to discard the oldest queued writes to free at least
   * `bytesNeeded` bytes. Returns true if any bytes were shed.
   */
  private shedOldestBytes(bytesNeeded: number): boolean {
    if (this.queue.length === 0 || this.flushing) return false

    let shedBytes = 0
    let shedCount = 0
    // Only shed up to half the queue to avoid discarding everything
    const maxShed = Math.floor(this.queue.length / 2)
    for (let i = 0; i < maxShed && shedBytes < bytesNeeded; i++) {
      shedBytes += this.queue[i].bytes
      shedCount++
    }

    if (shedCount === 0) return false

    const discarded = this.queue.splice(0, shedCount)
    for (const item of discarded) {
      this.queuedBytes -= item.bytes
    }

    // Notify about discarded chunks
    if (discarded.length > 0) {
      const shedError = new Error(
        `PtyWriteChannel: discarded ${discarded.length} oldest queued write(s) ` +
        `(${shedBytes} bytes) to prevent overflow`,
      )
      for (const item of discarded) {
        this.options.onWriteError?.(shedError, item.chunk)
      }
    }

    return shedBytes >= bytesNeeded
  }

  private flush(): boolean {
    if (this.flushing) {
      return true
    }

    this.flushing = true
    let currentChunk: string | null = null
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()
        if (!next) continue
        this.queuedBytes -= next.bytes
        currentChunk = next.chunk
        this.writable.write(next.chunk)
        currentChunk = null
      }
      return true
    } catch (error) {
      this.handleWriteError(error, currentChunk)
      return false
    } finally {
      this.flushing = false
    }
  }

  /**
   * PC-30 fix: overflow-specific handler that closes with 'queue_overflow' reason.
   */
  private handleOverflow(error: unknown, chunk: string | null): void {
    this.closed = true
    this._closedByError = true
    this._closeReason = 'queue_overflow'
    const remaining = this.queue.splice(0)
    this.queuedBytes = 0
    this.options.onWriteError?.(error, chunk)
    this.options.onClose?.('queue_overflow')
    if (remaining.length > 0) {
      const drainError = new Error('PtyWriteChannel closed due to queue overflow; queued data dropped')
      for (const item of remaining) {
        this.options.onWriteError?.(drainError, item.chunk)
      }
    }
  }

  private handleWriteError(error: unknown, chunk: string | null): void {
    this.closed = true
    this._closedByError = true
    this._closeReason = 'write_error'
    // Drain the remaining queue before clearing so callers are notified about
    // every chunk that will be silently dropped, not just the failing one.
    const remaining = this.queue.splice(0)
    this.queuedBytes = 0
    this.options.onWriteError?.(error, chunk)
    this.options.onClose?.('write_error')
    if (remaining.length > 0) {
      const drainError = new Error('PtyWriteChannel closed due to earlier write error; queued data dropped')
      for (const item of remaining) {
        this.options.onWriteError?.(drainError, item.chunk)
      }
    }
  }
}
