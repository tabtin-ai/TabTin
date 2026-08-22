/**
 * Registry — 进程内 singleton 注册中心。
 *
 * ⚠️ **每个进程内一份 singleton**（W2.2 接入必读）：
 *   - Electron main 进程一份、renderer 一份、preload 一份、Daemon 一份
 *   - 业务模块必须明确知道自己跑在哪个进程，并在该进程的启动期注册
 *   - 跨进程聚合视图由 `RendererStorageBridge` 完成（renderer 通过 IPC 拉
 *     main bucket，通过 Daemon CLI 拉 daemon bucket）
 *   - **业务模块不要尝试跨进程注册**——直接在自己跑的进程注册即可
 *
 * 设计意图：
 *   - 提供 `registerStorageBucket` / `listBuckets` / `getBucket` /
 *     `clearBucket` / `exportBucket` / `getBucketSize` 等 API；
 *   - singleton 是为了"该进程内任意业务模块在任意位置 import 后都能注册到
 *     同一个表"——这是注册中心的产品要求；
 *   - 提供 `__resetForTesting()` 给单元测试用，避免 singleton 引入测试隔离问题；
 *   - 重复注册同 id 抛 `BucketAlreadyRegisteredError`（明确错误优于静默覆盖）；
 *   - 操作不存在 / 无对应能力的 bucket 抛 `BucketNotFoundError` /
 *     `BucketCapabilityMissingError`，便于调用方区分两类错误。
 */

import {
  type BucketCategory,
  type BucketGroup,
  type BucketSize,
  type ClearOptions,
  type ClearResult,
  type ExportResult,
  type StorageBucket,
  assertValidBucket,
  defaultConfirmationFor,
} from './bucket.js'

// ── 错误类型 ────────────────────────────────────────────────────

/** 注册中心相关错误的公共基类，便于 `instanceof` 单一拦截。 */
export class StorageManagerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StorageManagerError'
  }
}

export class BucketAlreadyRegisteredError extends StorageManagerError {
  public readonly bucketId: string
  constructor(bucketId: string) {
    super(
      `[storage-manager] bucket "${bucketId}" 已注册——重复注册视为编程错误，请先 unregister 或换 id`,
    )
    this.name = 'BucketAlreadyRegisteredError'
    this.bucketId = bucketId
  }
}

export class BucketNotFoundError extends StorageManagerError {
  public readonly bucketId: string
  constructor(bucketId: string) {
    super(`[storage-manager] bucket "${bucketId}" 未注册`)
    this.name = 'BucketNotFoundError'
    this.bucketId = bucketId
  }
}

export class BucketCapabilityMissingError extends StorageManagerError {
  public readonly bucketId: string
  public readonly capability: 'listFn' | 'clearFn' | 'exportFn'
  constructor(
    bucketId: string,
    capability: 'listFn' | 'clearFn' | 'exportFn',
  ) {
    super(
      `[storage-manager] bucket "${bucketId}" 未实现 ${capability}——该桶未声明该能力`,
    )
    this.name = 'BucketCapabilityMissingError'
    this.bucketId = bucketId
    this.capability = capability
  }
}

// ── singleton 状态 ──────────────────────────────────────────────

const _buckets = new Map<string, StorageBucket>()

// ── 公开 API ───────────────────────────────────────────────────

/**
 * 注册一个 bucket。返回 unregister 函数（业务模块销毁时调用）。
 * 同 id 重复注册抛 `BucketAlreadyRegisteredError`。
 */
export function registerStorageBucket(bucket: StorageBucket): () => void {
  assertValidBucket(bucket)

  if (_buckets.has(bucket.id)) {
    throw new BucketAlreadyRegisteredError(bucket.id)
  }

  // 补全 requiresConfirmation 默认值，让运行时不再有 undefined 状态——
  // UI 直接读这个字段决定 affordance，类型层就把"没指定"消化掉。
  const normalized: StorageBucket = {
    ...bucket,
    requiresConfirmation:
      bucket.requiresConfirmation ?? defaultConfirmationFor(bucket.category),
    hideFromList: bucket.hideFromList ?? false,
  }

  _buckets.set(bucket.id, normalized)

  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    // 仅当当前持有者还是这个实例时才删——防止"先 unregister 再 register 同 id"被
    // 旧 unregister 误删。
    if (_buckets.get(bucket.id) === normalized) {
      _buckets.delete(bucket.id)
    }
  }
}

/**
 * 列出所有 bucket。filter 多条件时是 AND 关系（group AND category）。
 * 默认隐藏 `hideFromList: true` 的 bucket，可通过 `includeHidden: true` 强制返回。
 */
export function listBuckets(filter?: {
  group?: BucketGroup
  category?: BucketCategory
  includeHidden?: boolean
}): StorageBucket[] {
  const all = Array.from(_buckets.values())
  return all.filter((b) => {
    if (filter?.group !== undefined && b.group !== filter.group) return false
    if (filter?.category !== undefined && b.category !== filter.category)
      return false
    if (!filter?.includeHidden && b.hideFromList) return false
    return true
  })
}

/** 按 id 取 bucket。未注册返回 undefined（不抛错——查询语义）。 */
export function getBucket(id: string): StorageBucket | undefined {
  return _buckets.get(id)
}

/**
 * 容量探测——所有 UI tab 进入时批量调的入口。
 * bucket 不存在 → `BucketNotFoundError`。
 * `sizeFn` 抛错时直接向上抛（调用方决定怎么聚合错误）。
 */
export async function getBucketSize(id: string): Promise<BucketSize> {
  const bucket = _buckets.get(id)
  if (!bucket) throw new BucketNotFoundError(id)
  return bucket.sizeFn()
}

/**
 * 清理——触发 D-4 四档对话框走完后的实际操作。
 * - bucket 不存在 → `BucketNotFoundError`
 * - bucket 没声明 clearFn → `BucketCapabilityMissingError`
 */
export async function clearBucket(
  id: string,
  options?: ClearOptions,
): Promise<ClearResult> {
  const bucket = _buckets.get(id)
  if (!bucket) throw new BucketNotFoundError(id)
  if (!bucket.clearFn) {
    throw new BucketCapabilityMissingError(id, 'clearFn')
  }
  return bucket.clearFn(options)
}

/**
 * 导出——v1 仅 5 个核心资产（voice/bookmarks/草稿/Checkpoint 摘要/对话摘要）实现。
 * - bucket 不存在 → `BucketNotFoundError`
 * - bucket 没声明 exportFn → `BucketCapabilityMissingError`
 */
export async function exportBucket(id: string): Promise<ExportResult> {
  const bucket = _buckets.get(id)
  if (!bucket) throw new BucketNotFoundError(id)
  if (!bucket.exportFn) {
    throw new BucketCapabilityMissingError(id, 'exportFn')
  }
  return bucket.exportFn()
}

/**
 * 列出子项——bucket 没声明 listFn → `BucketCapabilityMissingError`。
 * UI 用此 API 在卡片"展开"时拉子项明细（如对话历史按 Space 列出 sessions）。
 */
export async function listBucketItems(id: string) {
  const bucket = _buckets.get(id)
  if (!bucket) throw new BucketNotFoundError(id)
  if (!bucket.listFn) {
    throw new BucketCapabilityMissingError(id, 'listFn')
  }
  return bucket.listFn()
}

// ── 测试支持 ────────────────────────────────────────────────────

/**
 * 仅供单元测试用——清空 singleton 全部状态。
 * 生产代码绝对不要调用（会让其他模块的 bucket 突然消失）。
 */
export function __resetForTesting(): void {
  _buckets.clear()
}
