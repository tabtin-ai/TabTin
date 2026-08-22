/**
 * @tabtin/agent-runtime — JSONL Snapshot Storage
 *
 * Append-only JSONL file: {sessionDir}/{sessionId}/snapshots.jsonl
 * Each line is a JSON-serialised LLMCallSnapshot.
 *
 * Buffered write with flush-on-threshold / timer (simplified version of
 * SessionStorage's pattern). Snapshots are relatively infrequent (one per
 * LLM call), so the buffer is small and flush interval generous.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class SnapshotStorage {
  /**
   * 落盘文件绝对路径（SSoT）。caller 需要"snapshots 文件在哪"时直接读这里，
   * 不要外部再 `path.join(sessionDir, sessionId, 'snapshots.jsonl')`——避免
   * 哪天本类改文件名 / 目录布局时外部静默漂移。
   */
  readonly filePath: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  private static readonly FLUSH_INTERVAL_MS = 1000;
  private static readonly FLUSH_THRESHOLD = 5;

  constructor(sessionDir: string, sessionId: string) {
    const dir = path.join(sessionDir, sessionId);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.filePath = path.join(dir, 'snapshots.jsonl');
  }

  async append(snapshot: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(snapshot) + '\n';
    this.buffer.push(line);

    if (this.buffer.length >= SnapshotStorage.FLUSH_THRESHOLD) {
      this.writeQueue = this.writeQueue.then(() => this._flush());
      await this.writeQueue;
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.writeQueue = this.writeQueue.then(() => this._flush());
      }, SnapshotStorage.FLUSH_INTERVAL_MS);
    }
  }

  async dispose(): Promise<void> {
    await this._flush();
  }

  private async _flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.join('');
    this.buffer = [];

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    try {
      await fs.promises.appendFile(this.filePath, batch, { mode: 0o600 });
    } catch (err) {
      // 阶段 8 Review fix：原版本 _flush throw → 调用方常用 .catch(() => undefined)
      // 全静默吞，dogfood 时"snapshots.jsonl 一行没写"无人知晓。至少 console.warn
      // 一次让运维 / dev 能在终端看到信号。不 rethrow——本类承诺"可观测性写入失败
      // 不阻断主流"，与 SessionStorage._flush 的容错策略对齐。
      try {
        // eslint-disable-next-line no-console
        console.warn(
          `[snapshot-storage] flush failed for ${this.filePath}: ${(err as Error)?.message ?? err}`,
        );
      } catch { /* ignore log error */ }
    }
  }
}
