export class OutputCollector {
  private readonly maxBytes: number;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private collectedBytes = 0;
  private truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(0, maxBytes);
  }

  appendStdout(chunk: Buffer): void {
    this.appendChunk(chunk, this.stdoutChunks);
  }

  appendStderr(chunk: Buffer): void {
    this.appendChunk(chunk, this.stderrChunks);
  }

  getStdout(): string {
    return Buffer.concat(this.stdoutChunks).toString('utf8');
  }

  getStderr(): string {
    return Buffer.concat(this.stderrChunks).toString('utf8');
  }

  isTruncated(): boolean {
    return this.truncated;
  }

  private appendChunk(chunk: Buffer, target: Buffer[]): void {
    if (this.truncated || this.maxBytes === 0) {
      if (this.maxBytes === 0) {
        this.truncated = true;
      }
      return;
    }

    const remaining = this.maxBytes - this.collectedBytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }

    if (chunk.length <= remaining) {
      target.push(chunk);
      this.collectedBytes += chunk.length;
      return;
    }

    target.push(chunk.subarray(0, remaining));
    this.collectedBytes += remaining;
    this.truncated = true;
  }
}
