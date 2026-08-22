/**
 * WorkerTaskRunner — 通用 Worker 线程池
 *
 * **H2-E 重构后**：实现已迁到 `@tabtin/local-docparse/workers`，本文件保留为再
 * 导出薄壳，避免破坏其他 worker 池的现有 import 路径。
 *
 * 注：未来新 worker 类型也建议直接 `import from '@tabtin/local-docparse/workers'`，
 * 此 wrapper 仅为兼容性保留。
 */

export {
  WorkerTaskAbortedError,
  WorkerTaskError,
  WorkerTaskRunner,
} from '@tabtin/local-docparse/workers'

export type {
  QueueStrategy,
  WorkerTaskOptions,
  WorkerTaskRunnerOptions,
} from '@tabtin/local-docparse/workers'
