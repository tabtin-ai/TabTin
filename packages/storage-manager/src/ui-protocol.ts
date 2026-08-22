/**
 * UI Protocol — 纯 DTO 类型，无业务逻辑、无函数引用。
 *
 * 设计意图：
 *   - bucket 含 sizeFn/clearFn/exportFn 等函数引用，无法跨 IPC 通道传输
 *     （Electron 的 contextBridge 不允许跨进程传函数），因此面向 UI 的协议
 *     必须用纯 DTO 表达"能力声明"和"度量结果"；
 *   - 主进程 ipc-bridge / 渲染进程 renderer-bridge / Daemon CLI 都依赖
 *     这一份 DTO 定义——单一来源避免类型漂移（R4 风险登记）。
 */

import {
  defaultConfirmationFor,
  type BucketCategory,
  type BucketGroup,
  type BucketItem,
  type ClearOptions,
  type ClearResult,
  type ConfirmationLevel,
  type StorageBucket,
} from './bucket.js'

// ── Bucket 描述符（list-buckets 的返回 DTO） ────────────────────

/**
 * 主进程 / Daemon 把 bucket "脱壳"为 DTO 后传给 UI——剥掉所有函数引用，
 * 但保留所有 UI 需要的元信息 + 用 `capabilities` 标记可调用的能力。
 */
export interface BucketDescriptor {
  id: string
  category: BucketCategory
  group: BucketGroup
  displayName: string
  description: string
  warnings?: string[]
  /** 已经按 category 推导补齐过默认值，UI 直接读 */
  requiresConfirmation: ConfirmationLevel
  /** 已经按默认值补齐 */
  hideFromList: boolean
  /**
   * 该桶实际声明了哪些能力——UI 渲染按钮时用来灰掉不支持的操作。
   *
   * 注意：sizeFn 是必填，因此没有 `canMeasureSize` 标记（永远 true）。
   */
  capabilities: {
    canList: boolean
    canClear: boolean
    canExport: boolean
  }
  /**
   * 该 bucket 来自哪个进程——UI 在概览页可以聚合显示
   * "Electron 主进程 / 渲染进程 / Daemon"的容量分布。
   */
  source?: BucketSource
}

/** Bucket 来源——UI 聚合展示用，bridge 在转 DTO 时填。 */
export type BucketSource = 'main' | 'renderer' | 'daemon'

// ── 度量与操作返回 DTO ──────────────────────────────────────────

export interface BucketSizeReport {
  id: string
  bytes: number
  itemCount?: number
  /** unix ms，UI 在概览页显示"上次测量于 X 秒前" */
  measuredAt: number
}

export interface BucketItemListReport {
  id: string
  items: BucketItem[]
  measuredAt: number
}

export interface BucketClearReport extends ClearResult {
  id: string
  /** 是否 dryRun，UI 在"输入名字确认"对话框预览时填 true */
  dryRun: boolean
}

/**
 * 导出 payload——IPC 不能直接传 Blob，所以本 DTO 用 base64 编码二进制 /
 * 直接 string 携带文本。UI 收到后解码或直接 new Blob([data]) 触发下载。
 */
export interface ExportPayload {
  id: string
  filename: string
  /**
   * 数据负载：
   *   - 文本类（JSON / CSV / Markdown）→ 直接 string
   *   - 二进制类（zip / 图片）→ base64 编码 string
   *
   * `encoding` 字段指明语义，UI 用此选择是否 atob 还原 Uint8Array。
   */
  data: string
  encoding: 'utf-8' | 'base64'
  mimeType: string
}

// ── IPC 通道名常量 ──────────────────────────────────────────────

/**
 * Electron IPC 通道名——main 与 renderer 共用同一份常量，避免硬编码漂移。
 * 命名约定：`storage-manager:<verb>-<noun>`。
 */
export const IPC_CHANNELS = {
  LIST_BUCKETS: 'storage-manager:list-buckets',
  GET_BUCKET_SIZE: 'storage-manager:get-bucket-size',
  LIST_BUCKET_ITEMS: 'storage-manager:list-bucket-items',
  CLEAR_BUCKET: 'storage-manager:clear-bucket',
  EXPORT_BUCKET: 'storage-manager:export-bucket',
} as const

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS]

// ── 转换 helper ─────────────────────────────────────────────────

/**
 * 把内部 `StorageBucket` 转为面向 UI 的 `BucketDescriptor`。
 *
 * 注意调用前提：bucket 必须已经过 `assertValidBucket` 校验过（registry 已校验）。
 * `requiresConfirmation` / `hideFromList` 在 register 阶段已补齐，本函数只做投影。
 */
export function bucketToDescriptor(
  bucket: StorageBucket,
  source?: BucketSource,
): BucketDescriptor {
  return {
    id: bucket.id,
    category: bucket.category,
    group: bucket.group,
    displayName: bucket.displayName,
    description: bucket.description,
    warnings: bucket.warnings ? [...bucket.warnings] : undefined,
    // requiresConfirmation 在 register 时已经按 category 默认值补齐，
    // 但这里仍按 category 兜底一次——保持纯函数语义，让 bucketToDescriptor
    // 单独使用（测试 / 单元转换）时也能产出正确 DTO。
    requiresConfirmation:
      bucket.requiresConfirmation ?? defaultConfirmationFor(bucket.category),
    hideFromList: bucket.hideFromList ?? false,
    capabilities: {
      canList: typeof bucket.listFn === 'function',
      canClear: typeof bucket.clearFn === 'function',
      canExport: typeof bucket.exportFn === 'function',
    },
    source,
  }
}

// ── 重新导出 ClearOptions（IPC 桥需要这个类型） ────────────────

export type { BucketCategory, BucketGroup, BucketItem, ClearOptions, ClearResult, ConfirmationLevel }
