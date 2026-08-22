/**
 * 本地向量服务 —— 语义双路召回的宿主侧单例。
 *
 * 职责与生命周期（与方案文档一致）：
 * - 宿主进程（Electron main / Daemon）启动时创建单例并后台 `warmup()`；
 * - `warmup()` 完成前所有接口返回 null，调用方（双路融合层）自动走词法单路；
 * - 候选向量：内容哈希键，内存 Map + 磁盘快照（`VectorCache`），未命中现算回写；
 * - 查询向量：进程内 LRU + 进行中请求去重，不落盘。
 */

import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EmbeddingBackend } from './backend.js';
import { OnnxBackend } from './backend.js';
import { ProcessIsolatedBackend, type ForkOnnxChild } from './process-isolated-backend.js';
import {
  DEFAULT_MODEL_ID,
  EMBEDDING_DIMS,
  PASSAGE_PREFIX,
  QUERY_LRU_CAPACITY,
  QUERY_PREFIX,
  SNAPSHOT_DEBOUNCE_MS,
  WARMUP_RETRY_INTERVAL_MS,
} from './constants.js';
import { VectorCache } from './vector-cache.js';

export interface LocalEmbeddingServiceOptions {
  /**
   * 模型文件根目录（内部按 modelId 分子目录），默认 `~/.tabtin/models`。
   * 生产环境宿主应指向安装包内置目录（如 `process.resourcesPath/models`），
   * 本包只读本地文件、无下载能力。
   */
  modelsDir?: string;
  /** 向量缓存根目录，默认 `~/.tabtin/embedding-cache`（内部按模型分子目录）。 */
  cacheDir?: string;
  modelId?: string;
  /** 测试注入假后端；显式传入时优先级最高。 */
  backend?: EmbeddingBackend;
  /**
   * onnxruntime 进程隔离（方案 B）子进程 entry 的绝对路径。传入时后端走
   * `ProcessIsolatedBackend`——推理关进独立子进程，ORT 崩溃只死子进程、主进程
   * 降级词法，绝不 SIGABRT 宿主。**宿主（Electron/Daemon）应尽量传入此路径**；
   * 缺省（未传且未注入 backend）回落到同进程 `OnnxBackend`（历史行为，无隔离）。
   */
  onnxChildEntryPath?: string;
  /** 进程隔离后端的 fork 注入（测试用）；生产缺省 node:child_process.fork。 */
  fork?: ForkOnnxChild;
  /** 诊断日志回调（宿主接自己的 logger），缺省静默。 */
  log?: (message: string) => void;
}

function defaultTabtinDir(): string {
  return path.join(os.homedir(), '.tabtin');
}

/** 模型 id 含 `/`，转成可作目录名的形式。 */
function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9.-]+/g, '__');
}

export class LocalEmbeddingService {
  private readonly modelId: string;
  private readonly backend: EmbeddingBackend;
  private readonly cache: VectorCache;
  private readonly log: (message: string) => void;

  private ready = false;
  private warmupPromise: Promise<void> | null = null;
  /** 上次 warmup 失败的时间戳——惰性重试的节流基准（0 = 从未失败）。 */
  private lastWarmupFailureAt = 0;

  /** 查询向量 LRU：Map 迭代序即插入序，超容量删最旧。 */
  private readonly queryLru = new Map<string, Float32Array>();
  /** 进行中的查询推理去重：同一轮三路能力共用同一查询，只算一次。 */
  private readonly inflightQueries = new Map<string, Promise<Float32Array | null>>();

  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: LocalEmbeddingServiceOptions = {}) {
    this.modelId = options.modelId ?? DEFAULT_MODEL_ID;
    this.log = options.log ?? (() => {});
    const modelsDir = options.modelsDir ?? path.join(defaultTabtinDir(), 'models');
    const cacheRoot = options.cacheDir ?? path.join(defaultTabtinDir(), 'embedding-cache');
    const modelDir = path.join(modelsDir, this.modelId);
    this.backend =
      options.backend ??
      (options.onnxChildEntryPath
        ? new ProcessIsolatedBackend({
            childEntryPath: options.onnxChildEntryPath,
            modelDir,
            dims: EMBEDDING_DIMS,
            ...(options.fork ? { fork: options.fork } : {}),
            log: this.log,
          })
        : new OnnxBackend({ modelDir, dims: EMBEDDING_DIMS }));
    this.cache = new VectorCache({
      dir: path.join(cacheRoot, sanitizeModelId(this.modelId)),
      modelId: this.modelId,
      dims: EMBEDDING_DIMS,
    });
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * 加载本地模型 + 磁盘缓存。幂等：并发调用共享同一个 Promise；
   * 失败后再次调用会重试（dev 环境补置模型文件后无需重启进程）。
   */
  warmup(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.warmupPromise) return this.warmupPromise;
    this.warmupPromise = (async () => {
      try {
        await Promise.all([this.backend.load(), this.cache.load()]);
        this.ready = true;
        this.lastWarmupFailureAt = 0;
        this.log(`[local-embedding] 模型 ${this.modelId} 就绪，缓存条目 ${this.cache.size}`);
      } catch (err) {
        this.lastWarmupFailureAt = Date.now();
        this.log(`[local-embedding] warmup 失败：${err instanceof Error ? err.message : String(err)}`);
        throw err;
      } finally {
        this.warmupPromise = null;
      }
    })();
    // 防止无人 await 时产生 unhandledRejection；错误已记日志。
    this.warmupPromise.catch(() => {});
    return this.warmupPromise;
  }

  /**
   * warmup 曾失败且过了节流间隔 → 后台再试一次（不阻塞当前调用）。
   *
   * 宿主只在进程启动时主动调一次 `warmup()`，若当时模型文件缺失（dev 未跑
   * 置入脚本），没有这个钩子语义路会整个进程生命周期静默失效。重试只重读
   * 本地磁盘，不产生任何网络请求。
   */
  private maybeRetryWarmup(): void {
    if (this.ready || this.warmupPromise) return;
    if (this.lastWarmupFailureAt === 0) return;
    if (Date.now() - this.lastWarmupFailureAt < WARMUP_RETRY_INTERVAL_MS) return;
    this.log('[local-embedding] warmup 曾失败，后台重试');
    void this.warmup().catch(() => {}); // 失败已在 warmup 内记日志并刷新节流基准
  }

  /** 计算查询向量。未就绪 / 推理失败返回 null，不抛错。 */
  async embedQuery(text: string): Promise<Float32Array | null> {
    if (!this.ready) {
      this.maybeRetryWarmup();
      return null;
    }
    const cached = this.queryLru.get(text);
    if (cached) {
      // LRU 触碰：删后重插保持插入序 = 最近使用序
      this.queryLru.delete(text);
      this.queryLru.set(text, cached);
      return cached;
    }
    const inflight = this.inflightQueries.get(text);
    if (inflight) return inflight;

    const task = (async (): Promise<Float32Array | null> => {
      try {
        const [vec] = await this.backend.embed([`${QUERY_PREFIX}${text}`]);
        this.queryLru.set(text, vec);
        while (this.queryLru.size > QUERY_LRU_CAPACITY) {
          const oldest = this.queryLru.keys().next().value as string;
          this.queryLru.delete(oldest);
        }
        return vec;
      } catch (err) {
        this.log(`[local-embedding] 查询推理失败：${err instanceof Error ? err.message : String(err)}`);
        return null;
      } finally {
        this.inflightQueries.delete(text);
      }
    })();
    this.inflightQueries.set(text, task);
    return task;
  }

  /**
   * 批量计算候选向量：优先读缓存，未命中的现算并回写（防抖快照落盘）。
   * 未就绪时命中缓存的照常返回、未命中的为 null——启动早期也能用上历史缓存。
   */
  async embedPassages(texts: string[]): Promise<(Float32Array | null)[]> {
    const result: (Float32Array | null)[] = new Array(texts.length).fill(null);
    const missIndexes: number[] = [];

    for (let i = 0; i < texts.length; i++) {
      const vec = this.cache.get(this.passageHash(texts[i]));
      if (vec) {
        result[i] = vec;
      } else {
        missIndexes.push(i);
      }
    }
    if (missIndexes.length === 0 || !this.ready) return result;

    try {
      const vecs = await this.backend.embed(
        missIndexes.map((i) => `${PASSAGE_PREFIX}${texts[i]}`),
      );
      missIndexes.forEach((textIndex, k) => {
        result[textIndex] = vecs[k];
        this.cache.set(this.passageHash(texts[textIndex]), vecs[k]);
      });
      this.scheduleFlush();
    } catch (err) {
      this.log(`[local-embedding] 候选推理失败：${err instanceof Error ? err.message : String(err)}`);
    }
    return result;
  }

  /** 立即落盘（测试 / 宿主退出前可选调用）。 */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      await this.cache.flush();
    } catch (err) {
      this.log(`[local-embedding] 缓存落盘失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private passageHash(text: string): string {
    return createHash('sha256').update(`${this.modelId}\n${text}`).digest('hex');
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.cache.flush().catch((err: unknown) => {
        this.log(`[local-embedding] 缓存落盘失败：${err instanceof Error ? err.message : String(err)}`);
      });
    }, SNAPSHOT_DEBOUNCE_MS);
    // 不阻止进程退出——缓存丢失只是重算
    this.flushTimer.unref?.();
  }
}
