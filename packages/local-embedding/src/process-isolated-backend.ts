/**
 * ProcessIsolatedBackend —— onnxruntime 进程隔离后端（方案 B）。
 *
 * 把推理关进独立子进程（`onnx-child-entry`）。宿主主进程**完全不加载
 * onnxruntime**，因此 ORT 再怎么 `abort()` 也只死子进程，主进程收到 exit →
 * 拒绝在途请求 → 上层 `LocalEmbeddingService` 降级词法召回。**任何失败路径
 * （fork 失败 / 子进程崩 / 超时 / 协议错）都表现为 embed 抛错，绝不连累主进程。**
 *
 * 自愈：子进程崩溃后按冷却间隔惰性重启，避免「崩→重启→再崩」的重生风暴。
 *
 * 本类**刻意不 import `OnnxBackend`**——保证宿主主进程侧的依赖图里不出现
 * onnxruntime。真正加载 ORT 的只有子进程 entry。
 */

import { createRequire } from 'node:module';
import type { EmbeddingBackend } from './backend.js';
import type {
  ChildInboundMessage,
  ChildOutboundMessage,
} from './isolation-protocol.js';

/** 子进程句柄的最小抽象（默认走 node:child_process.fork；测试可注入假实现）。 */
export interface IsolatedChild {
  send(msg: ChildInboundMessage): void;
  on(event: 'message', cb: (m: ChildOutboundMessage) => void): void;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (e: Error) => void): void;
  kill(): void;
}

export type ForkOnnxChild = (entryPath: string) => IsolatedChild;

export interface ProcessIsolatedBackendOptions {
  /** 子进程 entry 的绝对路径（宿主打包后的 `onnx-embed-child.mjs`）。 */
  childEntryPath: string;
  modelDir: string;
  dims: number;
  /** 注入 fork 实现（测试用）；缺省用 node:child_process.fork。 */
  fork?: ForkOnnxChild;
  /** 单次 embed 超时（毫秒），超时视为子进程卡死 → 杀掉重来。默认 30s。 */
  embedTimeoutMs?: number;
  /** load（含模型加载）超时（毫秒）。默认 120s。 */
  loadTimeoutMs?: number;
  /** 崩溃后重启的最小冷却间隔（毫秒），防重生风暴。默认 60s。 */
  respawnCooldownMs?: number;
  log?: (message: string) => void;
}

const DEFAULT_EMBED_TIMEOUT_MS = 30_000;
const DEFAULT_LOAD_TIMEOUT_MS = 120_000;
const DEFAULT_RESPAWN_COOLDOWN_MS = 60_000;

interface PendingEmbed {
  resolve: (v: Float32Array[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ProcessIsolatedBackend implements EmbeddingBackend {
  private readonly opts: Required<Omit<ProcessIsolatedBackendOptions, 'fork' | 'log'>> & {
    fork: ForkOnnxChild;
    log: (m: string) => void;
  };

  private child: IsolatedChild | null = null;
  private ready = false;
  private nextId = 1;
  private readonly inflight = new Map<number, PendingEmbed>();
  private loadWaiter: { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private lastSpawnAttemptAt = 0;
  private disposed = false;

  constructor(options: ProcessIsolatedBackendOptions) {
    this.opts = {
      childEntryPath: options.childEntryPath,
      modelDir: options.modelDir,
      dims: options.dims,
      embedTimeoutMs: options.embedTimeoutMs ?? DEFAULT_EMBED_TIMEOUT_MS,
      loadTimeoutMs: options.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS,
      respawnCooldownMs: options.respawnCooldownMs ?? DEFAULT_RESPAWN_COOLDOWN_MS,
      fork: options.fork ?? defaultFork,
      log: options.log ?? (() => {}),
    };
  }

  async load(): Promise<void> {
    if (this.disposed) throw new Error('ProcessIsolatedBackend 已释放');
    if (this.ready && this.child) return;
    await this.spawnAndLoad();
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (this.disposed) throw new Error('ProcessIsolatedBackend 已释放');
    if (!this.ready || !this.child) {
      // 惰性自愈：崩溃后按冷却重启，冷却内直接抛错让上层走词法。
      await this.maybeRespawn();
    }
    const child = this.child;
    if (!this.ready || !child) {
      throw new Error('onnx 子进程不可用（已降级词法召回）');
    }
    const id = this.nextId++;
    return new Promise<Float32Array[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        this.opts.log(`[local-embedding] onnx 子进程 embed 超时（${this.opts.embedTimeoutMs}ms），重启子进程`);
        // 先拒绝本请求，再收尾杀子进程（teardown 只处理仍在 inflight 的其它请求）。
        reject(new Error('onnx 子进程 embed 超时'));
        this.teardown(new Error('onnx 子进程 embed 超时'));
      }, this.opts.embedTimeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.inflight.set(id, { resolve, reject, timer });
      try {
        child.send({ type: 'embed', id, texts });
      } catch (err) {
        clearTimeout(timer);
        this.inflight.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.teardown(new Error('已释放'));
  }

  // ── 私有 ────────────────────────────────────────────────────────

  private async maybeRespawn(): Promise<void> {
    const now = Date.now();
    if (now - this.lastSpawnAttemptAt < this.opts.respawnCooldownMs) return;
    try {
      await this.spawnAndLoad();
    } catch {
      // 已在 spawnAndLoad 内记日志；保持 not ready → embed 抛错降级。
    }
  }

  private spawnAndLoad(): Promise<void> {
    this.lastSpawnAttemptAt = Date.now();
    // 清理旧句柄
    this.teardown(new Error('重启子进程'));
    this.disposed = false;

    return new Promise<void>((resolve, reject) => {
      let child: IsolatedChild;
      try {
        child = this.opts.fork(this.opts.childEntryPath);
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        this.opts.log(`[local-embedding] onnx 子进程 fork 失败：${e.message}`);
        reject(e);
        return;
      }
      this.child = child;

      const timer = setTimeout(() => {
        this.opts.log(`[local-embedding] onnx 子进程 load 超时（${this.opts.loadTimeoutMs}ms）`);
        this.teardown(new Error('onnx 子进程 load 超时'));
      }, this.opts.loadTimeoutMs);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this.loadWaiter = { resolve, reject, timer };

      child.on('message', (m) => this.onMessage(m));
      child.on('exit', (code) => this.onExit(code));
      child.on('error', (e) => this.onChildError(e));

      try {
        child.send({ type: 'load', modelDir: this.opts.modelDir, dims: this.opts.dims });
      } catch (err) {
        this.teardown(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(m: ChildOutboundMessage): void {
    switch (m.type) {
      case 'loaded': {
        this.ready = true;
        const w = this.loadWaiter;
        this.loadWaiter = null;
        if (w) { clearTimeout(w.timer); w.resolve(); }
        break;
      }
      case 'load_error': {
        this.opts.log(`[local-embedding] onnx 子进程模型加载失败：${m.message}`);
        this.teardown(new Error(m.message));
        break;
      }
      case 'embedded': {
        const p = this.inflight.get(m.id);
        if (p) { this.inflight.delete(m.id); clearTimeout(p.timer); p.resolve(m.vectors); }
        break;
      }
      case 'embed_error': {
        const p = this.inflight.get(m.id);
        if (p) { this.inflight.delete(m.id); clearTimeout(p.timer); p.reject(new Error(m.message)); }
        break;
      }
    }
  }

  private onExit(code: number | null): void {
    if (this.ready || this.loadWaiter || this.inflight.size > 0) {
      this.opts.log(`[local-embedding] onnx 子进程退出（code=${code ?? 'null'}），降级词法召回`);
    }
    this.teardown(new Error(`onnx 子进程退出（code=${code ?? 'null'}）`));
  }

  private onChildError(e: Error): void {
    this.opts.log(`[local-embedding] onnx 子进程错误：${e.message}`);
    this.teardown(e);
  }

  /** 统一收尾：拒绝在途 load / embed，杀子进程，回到 not-ready。 */
  private teardown(reason: Error): void {
    this.ready = false;
    const w = this.loadWaiter;
    this.loadWaiter = null;
    if (w) { clearTimeout(w.timer); w.reject(reason); }
    for (const [, p] of this.inflight) { clearTimeout(p.timer); p.reject(reason); }
    this.inflight.clear();
    const child = this.child;
    this.child = null;
    if (child) { try { child.kill(); } catch { /* best effort */ } }
  }
}

/** 默认 fork：node:child_process.fork 子进程 entry，走 advanced 序列化（可传 Float32Array）。 */
function defaultFork(entryPath: string): IsolatedChild {
  // ESM 包内用 createRequire 拿 child_process（顶层静态 import 会把核心模块带进
  // 非 Node 构建图；本模块仅宿主 Node 侧使用）。
  const nodeRequire = createRequire(import.meta.url);
  const { fork } = nodeRequire('node:child_process') as typeof import('node:child_process');
  const cp = fork(entryPath, [], {
    serialization: 'advanced',
    // 从 Electron 主进程 fork 时，用 ELECTRON_RUN_AS_NODE 让子进程以 Node 运行
    // （否则会尝试再起一个 Electron app）。Daemon（纯 Node）下该变量无副作用。
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return cp as unknown as IsolatedChild;
}
