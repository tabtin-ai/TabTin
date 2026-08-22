/**
 * OfflineMessageBuffer — stores Agent messages locally when the WS
 * connection to the backend is unavailable, then replays them after
 * reconnection.
 *
 * Storage format: one ndjson file per thread under ~/.tabtin-daemon/offline-buffer/.
 * Each line is a JSON-serialized message with a sequence number.
 */

import {
  existsSync,
  mkdirSync,
  appendFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { readFile, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../observability/logging/logger.js';
import { getDaemonHomePath } from '@tabtin/shared/storage-paths';

const DEFAULT_BUFFER_DIR = getDaemonHomePath('offline-buffer');
const MAX_BUFFER_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB per thread
const MAX_TOTAL_BUFFER_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB global quota
const MAX_BUFFER_AGE_MS = 30 * 60 * 1000; // 30 min stale threshold
const QUOTA_CHECK_INTERVAL_MS = 60_000; // throttle: at most once per 60s

interface BufferedMessage {
  seq: number;
  timestamp: number;
  threadId: string;
  type: string;
  data: Record<string, any>;
}

export class OfflineMessageBuffer {
  private readonly bufferDir: string;
  private readonly logger: Logger;
  private seq = 0;
  private trimming = new Set<string>();
  private readonly pendingDuringTrim = new Map<string, BufferedMessage[]>();
  private lastQuotaCheckAt = 0;

  constructor(logger: Logger, bufferDir?: string) {
    this.logger = logger;
    this.bufferDir = bufferDir ?? DEFAULT_BUFFER_DIR;
    this.ensureDir();
  }

  private ensureDir(): void {
    if (!existsSync(this.bufferDir)) {
      mkdirSync(this.bufferDir, { recursive: true });
    }
  }

  private threadFile(threadId: string): string {
    const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.bufferDir, `${safe}.ndjson`);
  }

  /**
   * Enqueue a message for later replay.
   * Append is synchronous (small payload), but trim is deferred to avoid blocking.
   */
  enqueue(threadId: string, type: string, data: Record<string, any>): void {
    const filePath = this.threadFile(threadId);

    const msg: BufferedMessage = {
      seq: this.seq++,
      timestamp: Date.now(),
      threadId,
      type,
      data,
    };

    if (this.trimming.has(filePath)) {
      let pending = this.pendingDuringTrim.get(filePath);
      if (!pending) {
        pending = [];
        this.pendingDuringTrim.set(filePath, pending);
      }
      pending.push(msg);
      return;
    }

    try {
      if (existsSync(filePath)) {
        const stat = statSync(filePath);
        if (stat.size > MAX_BUFFER_SIZE_BYTES) {
          this.scheduleTrim(filePath);
          let pending = this.pendingDuringTrim.get(filePath);
          if (!pending) {
            pending = [];
            this.pendingDuringTrim.set(filePath, pending);
          }
          pending.push(msg);
          return;
        }
      }
    } catch { /* ignore stat errors */ }

    try {
      appendFileSync(filePath, JSON.stringify(msg) + '\n', 'utf8');
    } catch (err) {
      this.logger.error(`[OfflineBuffer] Failed to write: ${err}`);
    }

    this.enforceGlobalQuota().catch(err => {
      this.logger.warn(`[OfflineBuffer] Global quota check failed: ${err}`);
    });
  }

  /**
   * Enforce a global 100 MB quota across all .ndjson files.
   * Throttled to run at most once per 60s to avoid excessive directory scans.
   * When over quota, deletes oldest files (by mtime) until under limit.
   */
  private async enforceGlobalQuota(): Promise<void> {
    const now = Date.now();
    if (now - this.lastQuotaCheckAt < QUOTA_CHECK_INTERVAL_MS) return;
    this.lastQuotaCheckAt = now;

    let entries: string[];
    try {
      entries = (await readdir(this.bufferDir)).filter(f => f.endsWith('.ndjson'));
    } catch { return; }

    const fileStats: { path: string; size: number; mtimeMs: number }[] = [];
    let totalSize = 0;

    for (const f of entries) {
      const fp = join(this.bufferDir, f);
      try {
        const st = await stat(fp);
        totalSize += st.size;
        fileStats.push({ path: fp, size: st.size, mtimeMs: st.mtimeMs });
      } catch { /* skip inaccessible files */ }
    }

    if (totalSize <= MAX_TOTAL_BUFFER_SIZE_BYTES) return;

    fileStats.sort((a, b) => a.mtimeMs - b.mtimeMs);

    let deleted = 0;
    for (const f of fileStats) {
      if (totalSize <= MAX_TOTAL_BUFFER_SIZE_BYTES) break;
      try {
        unlinkSync(f.path);
        totalSize -= f.size;
        deleted++;
      } catch { /* best effort */ }
    }

    this.logger.warn(
      `[OfflineBuffer] Global quota enforced: deleted ${deleted} oldest file(s), ` +
      `remaining ~${Math.round(totalSize / 1024)}KB`,
    );
  }

  /**
   * Schedule an async trim to avoid blocking the event loop.
   */
  private scheduleTrim(filePath: string): void {
    if (this.trimming.has(filePath)) return;
    this.trimming.add(filePath);

    this.logger.warn(
      `[OfflineBuffer] Buffer exceeded ${MAX_BUFFER_SIZE_BYTES / 1024}KB, scheduling async trim`,
    );

    this.trimFileAsync(filePath).finally(() => {
      this.trimming.delete(filePath);
      this.flushPendingMessages(filePath);
    });
  }

  private flushPendingMessages(filePath: string): void {
    const pending = this.pendingDuringTrim.get(filePath);
    if (!pending || pending.length === 0) {
      this.pendingDuringTrim.delete(filePath);
      return;
    }
    this.pendingDuringTrim.delete(filePath);
    try {
      const lines = pending.map(m => JSON.stringify(m)).join('\n') + '\n';
      appendFileSync(filePath, lines, 'utf8');
    } catch (err) {
      this.logger.error(`[OfflineBuffer] Failed to flush pending messages: ${err}`);
    }
  }

  /**
   * Trim a buffer file by removing the first half of lines (async).
   */
  private async trimFileAsync(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const half = Math.floor(lines.length / 2);
      const remaining = lines.slice(half).join('\n') + '\n';
      await writeFile(filePath, remaining, 'utf8');
      this.logger.info(`[OfflineBuffer] Trimmed buffer: kept ${lines.length - half}/${lines.length} lines`);
    } catch (err) {
      this.logger.warn(`[OfflineBuffer] Trim failed: ${err}`);
    }
  }

  /**
   * Replay all buffered messages in chronological order.
   * Only deletes files where ALL messages were successfully replayed or expired.
   * Returns the count of successfully replayed messages.
   */
  async replayAll(
    sender: (threadId: string, type: string, data: Record<string, any>) => Promise<boolean>,
  ): Promise<number> {
    this.ensureDir();

    let files: string[];
    try {
      files = readdirSync(this.bufferDir).filter(f => f.endsWith('.ndjson'));
    } catch {
      return 0;
    }

    if (files.length === 0) return 0;

    let totalReplayed = 0;
    const filesToDelete: string[] = [];

    for (const file of files) {
      const filePath = join(this.bufferDir, file);
      try {
        const messages = await this.readReplayableMessages(filePath);
        const { replayed, failedMessages } = await this.replayMessages(messages, sender);
        totalReplayed += replayed;

        if (failedMessages.length === 0) {
          filesToDelete.push(filePath);
        } else if (failedMessages.length < messages.length) {
          // Partially successful: rewrite file with only the failed messages so
          // successfully sent messages are not re-delivered on the next replay
          // (they have no idempotency guard on the backend side). (WS-P1-3)
          try {
            const remaining = failedMessages.map(m => JSON.stringify(m)).join('\n') + '\n';
            await writeFile(filePath, remaining, 'utf8');
            this.logger.info(
              `[OfflineBuffer] Partial replay: rewrote file with ${failedMessages.length} remaining message(s)`,
            );
          } catch (writeErr) {
            this.logger.warn(`[OfflineBuffer] Failed to rewrite partially-replayed file: ${writeErr}`);
          }
        }
      } catch (err) {
        this.logger.warn(`[OfflineBuffer] Failed to read ${file}: ${err}`);
      }
    }

    for (const fp of filesToDelete) {
      try {
        await unlink(fp);
      } catch { /* ignore */ }
    }

    const retained = files.length - filesToDelete.length;
    this.logger.info(
      `[OfflineBuffer] Replayed ${totalReplayed} messages, deleted ${filesToDelete.length} files, retained ${retained}`,
    );
    return totalReplayed;
  }

  private async readReplayableMessages(filePath: string): Promise<BufferedMessage[]> {
    const content = await readFile(filePath, 'utf8');
    const messages: BufferedMessage[] = [];
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const message = JSON.parse(line) as BufferedMessage;
        if (Date.now() - message.timestamp <= MAX_BUFFER_AGE_MS) messages.push(message);
      } catch { /* skip malformed lines */ }
    }
    return messages.sort((a, b) => a.timestamp - b.timestamp || a.seq - b.seq);
  }

  private async replayMessages(
    messages: BufferedMessage[],
    sender: (threadId: string, type: string, data: Record<string, any>) => Promise<boolean>,
  ): Promise<{ replayed: number; failedMessages: BufferedMessage[] }> {
    let replayed = 0;
    const failedMessages: BufferedMessage[] = [];
    for (const message of messages) {
      try {
        if (await sender(message.threadId, message.type, message.data)) replayed++;
        else failedMessages.push(message);
      } catch (err) {
        this.logger.warn(`[OfflineBuffer] Replay failed for seq=${message.seq}: ${err}`);
        failedMessages.push(message);
      }
    }
    return { replayed, failedMessages };
  }

  /**
   * Remove all buffer files.
   */
  cleanup(): void {
    try {
      const files = readdirSync(this.bufferDir).filter(f => f.endsWith('.ndjson'));
      for (const file of files) {
        try {
          unlinkSync(join(this.bufferDir, file));
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }

  /**
   * Check if any unreplayed messages exist.
   */
  hasPending(): boolean {
    try {
      const files = readdirSync(this.bufferDir).filter(f => f.endsWith('.ndjson'));
      return files.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Return the number of pending buffer files (lightweight proxy for message count).
   * Called by StateWriter every 10s — must stay cheap (no file content reads).
   */
  getPendingCount(): number {
    try {
      return readdirSync(this.bufferDir).filter(f => f.endsWith('.ndjson')).length;
    } catch {
      return 0;
    }
  }
}
