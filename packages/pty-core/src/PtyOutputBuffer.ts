export class PtyOutputBuffer {
  private readonly chunks: Array<{ cursor: number; text: string; bytes: number }> = []
  private totalBytes = 0
  private nextCursor = 0
  /** PC-14 fix: sticky flag that stays true once any chunk has been evicted */
  private overflowed = false
  private readonly maxChunks: number

  constructor(private readonly maxBytes: number, maxChunks: number = 10_000) {
    this.maxChunks = maxChunks
  }

  append(text: string): void {
    let bytes = Buffer.byteLength(text, 'utf8')
    let finalText = text

    // PC-1: If a single chunk exceeds maxBytes, truncate it to maxBytes
    // (keeping the tail, which is more likely to contain the end marker).
    if (bytes > this.maxBytes) {
      finalText = PtyOutputBuffer.truncateToByteLimit(text, this.maxBytes)
      bytes = Buffer.byteLength(finalText, 'utf8')
    }

    this.chunks.push({
      cursor: this.nextCursor,
      text: finalText,
      bytes,
    })
    this.nextCursor += 1
    this.totalBytes += bytes

    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift()
      if (removed) {
        this.totalBytes -= removed.bytes
        this.overflowed = true // PC-14: sticky overflow flag
      }
    }

    while (this.chunks.length > this.maxChunks) {
      const removed = this.chunks.shift()
      if (removed) {
        this.totalBytes -= removed.bytes
        this.overflowed = true
      }
    }
  }

  /**
   * Truncate a string so that its UTF-8 byte length does not exceed `maxBytes`.
   * Keeps the **tail** of the string (more recent output is more valuable).
   */
  private static truncateToByteLimit(text: string, maxBytes: number): string {
    const buf = Buffer.from(text, 'utf8')
    if (buf.length <= maxBytes) return text
    // Slice from the end, but avoid returning a decoded string whose UTF-8
    // byte length grows past maxBytes because a partial leading code point
    // became U+FFFD (3 bytes).
    let start = buf.length - maxBytes
    let truncated = buf.subarray(start).toString('utf8')
    while (start < buf.length && Buffer.byteLength(truncated, 'utf8') > maxBytes) {
      start += 1
      truncated = buf.subarray(start).toString('utf8')
    }
    return truncated
  }

  createCursor(): number {
    return this.nextCursor
  }

  lastChunkCursor(): number {
    return this.nextCursor > 0 ? this.nextCursor - 1 : this.nextCursor
  }

  readAll(): string {
    return this.chunks.map((chunk) => chunk.text).join('')
  }

  readTail(chunkCount: number): string {
    if (!Number.isFinite(chunkCount) || chunkCount <= 0) {
      return ''
    }
    return this.chunks.slice(-Math.floor(chunkCount)).map((chunk) => chunk.text).join('')
  }

  /**
   * PC-28 fix: uses binary search O(log n) to find the first chunk with
   * cursor >= normalizedCursor, instead of a linear filter O(n).
   * This is safe because chunk cursors are monotonically increasing.
   */
  readFromCursor(cursor: number): string {
    const normalizedCursor = Number.isFinite(cursor) ? Math.max(0, Math.floor(cursor)) : 0
    if (this.chunks.length === 0) return ''

    // Binary search for the first chunk with cursor >= normalizedCursor
    let lo = 0
    let hi = this.chunks.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (this.chunks[mid].cursor < normalizedCursor) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }

    if (lo >= this.chunks.length) return ''

    const parts: string[] = []
    for (let i = lo; i < this.chunks.length; i++) {
      parts.push(this.chunks[i].text)
    }
    return parts.join('')
  }

  getChunkCount(): number {
    return this.chunks.length
  }

  getTotalBytes(): number {
    return this.totalBytes
  }

  /**
   * Returns the cursor of the oldest (first) chunk still in the buffer,
   * or -1 if the buffer is empty. Used to detect whether a stored cursor
   * has been evicted by overflow.
   */
  getOldestCursor(): number {
    return this.chunks.length > 0 ? this.chunks[0].cursor : -1
  }

  /**
   * Returns true once the buffer has ever evicted any chunk due to capacity
   * overflow. This is a sticky flag — once set, it never resets to false.
   * A cursor obtained before overflow may point to data that has been removed.
   *
   * PC-14 fix: uses a sticky `overflowed` flag instead of checking
   * `totalBytes >= maxBytes`, which could return false after eviction
   * reduces totalBytes below the threshold.
   */
  hasOverflowed(): boolean {
    return this.overflowed
  }
}
