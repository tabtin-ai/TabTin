/**
 * @tabtin/storage-manager — TabTin 本地存储统一注册中心。
 *
 * 各业务模块通过 `registerStorageBucket` 暴露 size/list/clear/export 能力，
 * UI（个人资料 → 存储管理面板）通过本包的 bridge 聚合渲染。
 *
 * 本包不做实际 IO——
 *   - 不读不写文件（不依赖 safe-fs）
 *   - 不直接依赖 Electron（通过 IpcMainTransport / IpcRendererInvoker 注入）
 *   - 不直接 spawn Daemon CLI（通过 DaemonStorageFetcher 注入）
 *
 */

// ── 类型与 helper ───────────────────────────────────────────────

export type {
  BucketCategory,
  BucketGroup,
  BucketItem,
  BucketSize,
  ClearOptions,
  ClearResult,
  ConfirmationLevel,
  ExportResult,
  StorageBucket,
} from './bucket.js'
export {
  InvalidBucketError,
  assertValidBucket,
  defaultConfirmationFor,
} from './bucket.js'

// ── 注册中心核心 API ────────────────────────────────────────────

export {
  BucketAlreadyRegisteredError,
  BucketCapabilityMissingError,
  BucketNotFoundError,
  StorageManagerError,
  __resetForTesting,
  clearBucket,
  exportBucket,
  getBucket,
  getBucketSize,
  listBucketItems,
  listBuckets,
  registerStorageBucket,
} from './registry.js'

// ── UI 协议 DTO ────────────────────────────────────────────────

export type {
  BucketClearReport,
  BucketDescriptor,
  BucketItemListReport,
  BucketSizeReport,
  BucketSource,
  ExportPayload,
  IpcChannel,
} from './ui-protocol.js'
export { IPC_CHANNELS, bucketToDescriptor } from './ui-protocol.js'

// ── IPC bridge（main 进程侧） ──────────────────────────────────

export type {
  IpcErrorPayload,
  IpcMainTransport,
  IpcResult,
} from './ipc-bridge.js'
export { registerStorageManagerIpc } from './ipc-bridge.js'

// ── Renderer bridge（渲染进程侧） ──────────────────────────────

export type { IpcRendererInvoker } from './renderer-bridge.js'
export {
  RendererStorageBridge,
  createMainProcessBridge,
} from './renderer-bridge.js'

// ── Daemon bridge（主进程拉 Daemon CLI） ───────────────────────

export type { DaemonStorageFetcher } from './daemon-bridge.js'
export {
  DaemonBridgeNotConfiguredError,
  createDaemonBridge,
  isDaemonStorageFetcherConfigured,
  setDaemonStorageFetcher,
} from './daemon-bridge.js'
