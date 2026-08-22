/**
 * 候选向量磁盘缓存 —— 语义双路召回。
 *
 * 存储形态：`<dir>/manifest.json`（条目索引 + 最近使用时间）+ `<dir>/vectors.bin`
 * （连续 Float32 向量，按 manifest 里的槽位偏移读取）。候选集几百条、总量
 * 几百 KB，全量读写成本可忽略，不引入向量库。
 *
 * 生命周期契约：
 * - 启动 `load()` 一次性全量加载进内存 Map，运行期读写全走内存；
 * - `flush()` 先**重读磁盘快照合并**再「临时文件写全量 + rename 原子替换」。
 *   Electron 与 Daemon 双进程共享同一目录：合并保证一方 flush 不清掉另一方
 *   刚写的条目（live 取证：touched-only 快照曾把 752 条清成 6 条，双进程
 *   交替运行会反复冷启动）。合并按 `lastUsedAt` 新者胜，无需文件锁——
 *   极端时序下输掉的仍只是丢缓存条目，下轮补算，无正确性问题；
 * - 孤儿清理由 TTL 承担：超过 `CACHE_ENTRY_TTL_MS` 未被使用的条目在快照
 *   重写时丢弃（清单里删掉的 skill/工具不再被 get，自然过期）。
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  CACHE_ENTRY_TTL_MS,
  MANIFEST_FILENAME,
  MANIFEST_VERSION,
  VECTORS_FILENAME,
} from './constants.js';

interface ManifestEntry {
  hash: string;
  /** 向量在 vectors.bin 中的槽位序号（非字节偏移）。 */
  slot: number;
  /** 最近使用时间（epoch ms）——TTL 过期与双进程合并的新者胜依据。 */
  lastUsedAt: number;
}

interface ManifestFile {
  version: number;
  modelId: string;
  dims: number;
  entries: ManifestEntry[];
}

interface CacheEntry {
  vec: Float32Array;
  lastUsedAt: number;
}

export class VectorCache {
  private readonly dir: string;
  private readonly modelId: string;
  private readonly dims: number;

  private entries = new Map<string, CacheEntry>();

  constructor(options: { dir: string; modelId: string; dims: number }) {
    this.dir = options.dir;
    this.modelId = options.modelId;
    this.dims = options.dims;
  }

  /**
   * 从磁盘加载快照。文件缺失 / 损坏 / 版本或模型不匹配一律按冷启动处理
   * （空缓存），不抛错——缓存丢失的代价只是重算。
   */
  async load(): Promise<void> {
    const snapshot = await this.readSnapshot();
    if (!snapshot) return;
    this.entries = snapshot;
  }

  get(hash: string): Float32Array | undefined {
    const entry = this.entries.get(hash);
    if (!entry) return undefined;
    entry.lastUsedAt = Date.now();
    return entry.vec;
  }

  set(hash: string, vec: Float32Array): void {
    this.entries.set(hash, { vec, lastUsedAt: Date.now() });
  }

  /** 内存中条目数，测试与诊断用。 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 全量快照原子落盘：先重读磁盘合并（保住其他进程新写的条目，按
   * `lastUsedAt` 新者胜），再丢弃超过 TTL 未使用的条目。写失败向上抛，
   * 由调用方（service）记日志——缓存不影响正确性。
   */
  async flush(): Promise<void> {
    const disk = await this.readSnapshot();
    if (disk) {
      for (const [hash, diskEntry] of disk) {
        const mine = this.entries.get(hash);
        if (!mine || mine.lastUsedAt < diskEntry.lastUsedAt) {
          this.entries.set(hash, diskEntry);
        }
      }
    }

    const cutoff = Date.now() - CACHE_ENTRY_TTL_MS;
    const manifestEntries: ManifestEntry[] = [];
    const chunks: Float32Array[] = [];
    let slot = 0;
    for (const [hash, entry] of this.entries) {
      if (entry.lastUsedAt < cutoff) {
        this.entries.delete(hash);
        continue;
      }
      manifestEntries.push({ hash, slot, lastUsedAt: entry.lastUsedAt });
      chunks.push(entry.vec);
      slot += 1;
    }

    const manifest: ManifestFile = {
      version: MANIFEST_VERSION,
      modelId: this.modelId,
      dims: this.dims,
      entries: manifestEntries,
    };
    const bin = Buffer.concat(
      chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)),
    );

    await fs.mkdir(this.dir, { recursive: true });
    // 先写两个临时文件再依次 rename。极端时序下（rename 之间被另一进程插入）
    // 可能出现 manifest 与 bin 不配对，readSnapshot() 的逐条边界校验会把越界
    // 条目跳过，代价同样只是补算。
    const manifestTmp = path.join(this.dir, `${MANIFEST_FILENAME}.tmp-${process.pid}`);
    const vectorsTmp = path.join(this.dir, `${VECTORS_FILENAME}.tmp-${process.pid}`);
    await fs.writeFile(vectorsTmp, bin);
    await fs.writeFile(manifestTmp, JSON.stringify(manifest));
    await fs.rename(vectorsTmp, path.join(this.dir, VECTORS_FILENAME));
    await fs.rename(manifestTmp, path.join(this.dir, MANIFEST_FILENAME));
  }

  /** 读并校验磁盘快照；任何异常返回 null（按无快照处理）。 */
  private async readSnapshot(): Promise<Map<string, CacheEntry> | null> {
    let manifest: ManifestFile;
    let bin: Buffer;
    try {
      const [manifestRaw, binRaw] = await Promise.all([
        fs.readFile(path.join(this.dir, MANIFEST_FILENAME), 'utf-8'),
        fs.readFile(path.join(this.dir, VECTORS_FILENAME)),
      ]);
      manifest = JSON.parse(manifestRaw) as ManifestFile;
      bin = binRaw;
    } catch {
      return null;
    }
    if (
      manifest.version !== MANIFEST_VERSION ||
      manifest.modelId !== this.modelId ||
      manifest.dims !== this.dims ||
      !Array.isArray(manifest.entries)
    ) {
      return null;
    }
    const bytesPerVector = this.dims * Float32Array.BYTES_PER_ELEMENT;
    const result = new Map<string, CacheEntry>();
    for (const entry of manifest.entries) {
      const start = entry.slot * bytesPerVector;
      const end = start + bytesPerVector;
      if (end > bin.byteLength) continue; // manifest 与 bin 不一致：跳过该条
      // 拷贝一份，避免共享底层 Buffer 生命周期
      const vec = new Float32Array(
        bin.buffer.slice(bin.byteOffset + start, bin.byteOffset + end),
      );
      result.set(entry.hash, {
        vec,
        lastUsedAt: typeof entry.lastUsedAt === 'number' ? entry.lastUsedAt : 0,
      });
    }
    return result;
  }
}
