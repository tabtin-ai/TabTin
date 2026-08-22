/**
 * W3.2 内部类型协议——bucket 卡片 + 4 档 Affordance 组件契约。
 *
 * 与 W3.1（容器层）解耦：W3.1 负责 IPC 调用、聚合数据，W3.2 负责"渲染卡片
 * + 触发清理对话框 + 触发导出"。两层之间用 props 传递 BucketDescriptor 数组
 * + 三个回调（onClear / onListItems / onExport），W3.1 hook 内部封装
 * RendererStorageBridge 调用，W3.2 不直接依赖 ipc。
 *
 * 这种分层让两个 Wave 可以并行实施 + 单元测试解耦：W3.2 的组件可以传 mock
 * 回调来跑守护测试，不需要拉起整个 IPC 桥。
 */

import type {
  BucketCategory,
  BucketClearReport,
  BucketDescriptor,
  BucketGroup,
  BucketItem,
  BucketItemListReport,
  BucketSizeReport,
  ClearOptions,
  ConfirmationLevel,
  ExportPayload,
} from '@tabtin/storage-manager'

export type {
  BucketCategory,
  BucketClearReport,
  BucketDescriptor,
  BucketGroup,
  BucketItem,
  BucketItemListReport,
  BucketSizeReport,
  ClearOptions,
  ConfirmationLevel,
  ExportPayload,
}

/** 触发清理 — W3.1 hook 内部转发 RendererStorageBridge.clearBucket */
export type ClearHandler = (
  id: string,
  options?: ClearOptions,
) => Promise<BucketClearReport>

/** 拉取 bucket 子项 — UI 在 L3 对话框 / buildTopItems 聚合用 */
export type ListItemsHandler = (id: string) => Promise<BucketItemListReport>

/** 触发导出 — W3.3 给 5 个核心 bucket 实现 exportFn，UI 只触发 */
export type ExportHandler = (id: string) => Promise<ExportPayload>

/**
 * 4 档 Affordance 解析结果（供 ClearConfirmDialog / BucketCard 共享）。
 * 注意 L3-soft / L3-hard / L4 都有"输入 displayName"步骤，差别在于：
 *   - L3-soft 单步：输入 displayName → 确认
 *   - L3-hard 双步：输入 displayName → 勾 checkbox → 确认
 *   - L4 三步：输入 displayName → 勾 checkbox → 进度条 + 最终确认
 *
 * D-4 + bucket.ts 的 `requiresConfirmation` + `category` 决定档位。
 */
export type AffordanceLevel = 'L1' | 'L2' | 'L3-soft' | 'L3-hard' | 'L4'

/**
 * 解析 bucket → 4 档 Affordance。
 *
 * 规则（严格按 D-4）：
 *   - cache + none → L1（绿，一键清，无对话框）
 *   - semi-cache + soft → L2（黄，单按钮确认）
 *   - data + soft → L3-soft（红，输入 displayName 单步）
 *   - data + hard + group ∈ {login, system} → L4（最严格档）
 *   - data + hard + 其他 group → L3-hard（输入 displayName + checkbox）
 *
 * 不在表内的组合（理论上 storage-manager 包的 assertValidBucket 已拦掉）
 * 兜底走 L3-hard 最保守档，避免 UI 层因为脏数据放过 data 类清理。
 */
export function resolveAffordanceLevel(
  descriptor: Pick<
    BucketDescriptor,
    'category' | 'requiresConfirmation' | 'group'
  >,
): AffordanceLevel {
  const { category, requiresConfirmation, group } = descriptor
  if (category === 'cache' && requiresConfirmation === 'none') return 'L1'
  if (category === 'semi-cache' && requiresConfirmation === 'soft') return 'L2'
  if (category === 'data') {
    if (requiresConfirmation === 'soft') return 'L3-soft'
    if (requiresConfirmation === 'hard') {
      return group === 'login' || group === 'system' ? 'L4' : 'L3-hard'
    }
  }
  return 'L3-hard'
}

/**
 * 容量数字格式化——直接复用 W3.1 `useStorageData` 中已实现的 `formatBytes`。
 *
 * 之前 W3.2 写过一份语义略不同的实现（GB 一位小数 / MB 取整 / KB 取整），
 * 与 W3.1 Overview tab 的格式不一致——同一 bucket 在 Overview 显示
 * "1.0 MB" 但在 BucketCard 显示 "1 MB"。**用户视角是数据精度割裂**。
 *
 * 修复：W3.2 直接 re-export W3.1 的实现，保证 4 个 tab 数字格式严格一致。
 * 单元测试随之改成断言"与 W3.1 同输出"。
 */
export { formatBytes } from '../utils/formatBytes'

/** 容器层向 W3.2 组件提供的数据 + 回调契约 */
export interface StorageManagerData {
  /** listAllBuckets 的去重合并结果 */
  descriptors: BucketDescriptor[]
  /** sizeMap[id] = { bytes, itemCount } — 容器层批量 sizeFn 后填，未量则 undefined */
  sizeMap: Record<string, BucketSizeReport | undefined>
  onClear: ClearHandler
  onListItems: ListItemsHandler
  onExport: ExportHandler
}
