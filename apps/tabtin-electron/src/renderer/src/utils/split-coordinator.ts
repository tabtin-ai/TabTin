import { useEffect, type DependencyList } from 'react'

/**
 * 分屏系统统一协调器
 *
 * 解决 Chat 分屏和 Canvas 分屏两套系统的协调问题：
 * 1. 统一的拖拽协议常量
 * 2. 跨系统事件总线
 * 3. 分屏状态摘要查询
 */

// ────────────────────────────────────────────────────────────
// 拖拽协议常量（统一命名，避免硬编码字符串散落各处）
// ────────────────────────────────────────────────────────────

/** Canvas 标签拖拽 */
export const DRAG_TYPE_TAB_META = 'application/tab-meta'
/** Canvas 标签排序 */
export const DRAG_TYPE_TAB_REORDER = 'application/tab-reorder'
/** Canvas 面板拖拽 */
export const DRAG_TYPE_PANE_DRAG = 'application/pane-drag'
/** Chat 会话拖拽 */
export const DRAG_TYPE_CHAT_SESSION = 'application/x-chat-session'
/** Chat 上下文引用拖拽 */
export const DRAG_TYPE_CHAT_CONTEXT = 'application/x-tabtin-chat-context'
/** 跨应用文件引用拖拽（对话图片 → 文档 / 多维表格附件） */
export const DRAG_TYPE_FILE_REF = 'application/x-tabtin-file-ref'

// ────────────────────────────────────────────────────────────
// 分屏事件总线
// ────────────────────────────────────────────────────────────

export type SplitSystem = 'chat' | 'canvas'

export type SplitEventType =
  | 'split:created'
  | 'split:removed'
  | 'split:pane-closed'
  | 'split:layout-changed'
  | 'split:active-changed'

export interface SplitEvent {
  system: SplitSystem
  type: SplitEventType
  spaceId: string
  detail?: Record<string, unknown>
}

type SplitEventListener = (event: SplitEvent) => void

const splitListeners = new Set<SplitEventListener>()

export function onSplitEvent(listener: SplitEventListener): () => void {
  splitListeners.add(listener)
  return () => { splitListeners.delete(listener) }
}

export function emitSplitEvent(event: SplitEvent): void {
  splitListeners.forEach(fn => {
    try { fn(event) } catch { /* 防止单个 listener 异常阻塞其他 */ }
  })
}

// ────────────────────────────────────────────────────────────
// 分屏状态摘要（类型仅在此定义，查询实现在 split-queries.ts）
// ────────────────────────────────────────────────────────────

export interface SplitSummary {
  system: SplitSystem
  spaceId: string
  paneCount: number
  isActive: boolean
}

// store-dependent 查询函数（getSplitSummaries / hasActiveSplit / clearAllSplitsForSpace）
// 已迁移至 @/utils/split-queries.ts 以消除 split-coordinator ↔ store 的循环依赖

/**
 * React Hook：监听分屏事件
 * 自动管理 listener 的注册与清理
 */
export function useSplitEventListener(
  listener: SplitEventListener,
  deps: DependencyList = [],
): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onSplitEvent(listener), deps)
}
