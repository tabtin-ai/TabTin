/**
 * Worker Task Protocol —— 主线程与 Worker 线程之间的类型安全通信协议
 *
 * **H2-E 重构后**：实现已迁到 `@tabtin/local-docparse/workers`，本文件保留为再
 * 导出薄壳，避免破坏其他 worker 若复用了同一协议名。
 */

export {
  serializeWorkerError,
} from '@tabtin/local-docparse/workers'

export type {
  SerializedWorkerError,
  WorkerTaskRequestMessage,
  WorkerTaskResponseMessage,
} from '@tabtin/local-docparse/workers'
