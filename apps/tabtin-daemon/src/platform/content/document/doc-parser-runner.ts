/**
 * doc-parser-runner — Daemon 侧 DocParser Worker 池入口
 *
 * 与 Electron 端 `apps/tabtin-electron/src/main/workers/doc-parser-runner.ts`
 * 对称。差异仅在 worker script 路径解析方式（Daemon 用 tsup 产物 `dist/workers/...`，
 * Electron 用 electron-vite 产物 `out/main/...`）和缺省并发上限（Daemon 默认 1，
 * 因为常跑在 NAS / 老服务器上 CPU 弱）。
 *
 * 环境变量：
 *   - `TABTIN_DOC_PARSER_WORKERS`（1–4 并发；默认 1）
 *   - `TABTIN_DOC_PARSER_IDLE_MS`（0=永不缩容；默认 30 分钟）
 *   - `TABTIN_WORKER_DEBUG`（=1 开启调试日志）
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WorkerTaskRunner,
  type DocParserPayloadMap,
  type DocParserResultMap,
  type DocParserTaskType,
  type WorkerTaskOptions,
} from '@tabtin/local-docparse/workers';
import type { DocParserPort } from '../../../base/content/doc-parser-port.js';

/**
 * Daemon 默认 1 个 worker（vs Electron 2）。Daemon 跑在用户的 NAS / 公司服务器
 * / 个人 PC 后台，CPU 通常弱于桌面；同时 Daemon 一次只服务一个用户，并发解析
 * 收益不大。`TABTIN_DOC_PARSER_WORKERS=2` 可让具备多核服务器的部署放宽。
 */
const WORKER_COUNT = Math.max(
  1,
  Math.min(4, Number(process.env.TABTIN_DOC_PARSER_WORKERS) || 1),
);
const WORKER_DEBUG = process.env.TABTIN_WORKER_DEBUG === '1';

/**
 * Worker 空闲回收时长。同 Electron 默认 30 分钟，平衡冷启动体感 vs 闲置内存
 * 占用（pdfjs + mammoth + xlsx 加载后约 30MB / worker，长开 Daemon 机型友好）。
 */
const IDLE_TIMEOUT_MS = Math.max(
  0,
  Number(process.env.TABTIN_DOC_PARSER_IDLE_MS) || 30 * 60 * 1000,
);

/**
 * 解析 worker 脚本路径。
 *
 * 两种调用上下文：
 *   1. **生产模式**（`pnpm build` 后跑 `node dist/index.js` 或安装的 `tabtin-daemon` bin）：
 *      `import.meta.url` 指向 `dist/workers/doc-parser-runner.js`；同级 `workers/` 下
 *      有 tsup 产物 `doc-parser-worker.js`。直接 `join(currentDir, 'workers', ...)`。
 *   2. **开发模式**（`pnpm dev` = `tsx src/index.ts`）：`import.meta.url` 指向源码
 *      `src/platform/content/document/doc-parser-runner.ts`。同级没有 tsup 产物。回退到 `dist/workers/`
 *      上一级 +`dist/workers/doc-parser-worker.js`，要求开发者已经跑过一次
 *      `pnpm build`。两种产物都不存在则抛带运行手册的明确错误。
 *
 * H2-E Verifier-B Review 必修项：v1.0 总是返回 dist 路径，dev 模式实际拼出
 * `src/workers/workers/doc-parser-worker.js`，本地解析永远拿不到 worker。
 */
function getWorkerScriptPath(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));

  // case 1: 生产模式 — currentDir 已是 dist/workers/ 同级
  const sameLevel = join(currentDir, 'workers', 'doc-parser-worker.js');
  if (existsSync(sameLevel)) return sameLevel;

  // case 2: dev 模式 — currentDir 是 src/workers/，需要找 dist/workers/...
  // src/workers/ → ../../dist/workers/doc-parser-worker.js
  const devFallback = resolve(currentDir, '..', '..', 'dist', 'workers', 'doc-parser-worker.js');
  if (existsSync(devFallback)) return devFallback;

  // 都不存在：抛带可读 hint 的错误，避免用户看到 "Cannot find module" 一头雾水
  throw new Error(
    `[doc-parser-runner] Worker script not found. Tried:\n`
    + `  - ${sameLevel}\n`
    + `  - ${devFallback}\n`
    + `Please run 'pnpm -C apps/tabtin-daemon build' to generate worker bundles.`,
  );
}

/** Lazily owns one document worker pool for one daemon runtime. */
export class DocParserRuntime implements DocParserPort {
  private runner: WorkerTaskRunner | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  constructor(private readonly createRunner: () => WorkerTaskRunner = createWorkerTaskRunner) {}

  readonly runTask = <T extends DocParserTaskType>(
    taskType: T,
    payload: DocParserPayloadMap[T],
    options?: WorkerTaskOptions,
  ): Promise<DocParserResultMap[T]> => {
    if (this.disposed || this.disposePromise) {
      return Promise.reject(new Error('DocParserRuntime is disposing or disposed'));
    }
    return this.getRunner().runTask<DocParserResultMap[T]>(taskType, payload, options);
  };

  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.disposePromise) return this.disposePromise;
    const runner = this.runner;
    const operation = (async () => {
      await runner?.dispose();
      if (this.runner === runner) this.runner = null;
      this.disposed = true;
    })();
    this.disposePromise = operation;
    try {
      await operation;
    } finally {
      this.disposePromise = null;
    }
  }

  private getRunner(): WorkerTaskRunner {
    if (!this.runner) {
      this.runner = this.createRunner();
    }
    return this.runner;
  }
}

function createWorkerTaskRunner(): WorkerTaskRunner {
  return new WorkerTaskRunner({
    workerScriptPath: getWorkerScriptPath(),
    concurrency: WORKER_COUNT,
    name: 'doc-parser',
    debug: WORKER_DEBUG,
    idleTimeoutMs: IDLE_TIMEOUT_MS,
  });
}
