import { CollabStatus } from '@tabtin/collab-core'
import type * as Y from 'yjs'

import { isMissingCollabTokenError } from '../externalDocumentSave'

export interface RealtimeCollabState {
  status: CollabStatus
  isFallback: boolean
  lastError?: string | null
  /** IndexedDB 是否已同步（ hydrate 门控） */
  isCacheReady?: boolean
  /** IndexedDB 中是否有缓存内容（ hydrate 门控） */
  hasCachedContent?: boolean
}

/**
 * TipTap 协作挂载呈现：
 * - realtime：用 Y.Doc 驱动 Collaboration extension
 * - loading：等待首次 hydrate，不挂 REST、也不挂空 Y.Doc
 * - rest：legacy fallback / 缺 token / force-close 等终态
 */
export type CollabEditorPresentation = 'realtime' | 'loading' | 'rest'

/**
 * 当前协作态是否已具备可安全挂载 Collaboration 的内容源。
 * SYNCED（服务端已灌入）或本地 cache ready 且确有内容。
 */
export function isCollabContentHydrated(
  collaborative: RealtimeCollabState | null | undefined,
): boolean {
  if (!collaborative || collaborative.isFallback) return false
  if (collaborative.status === CollabStatus.FORCE_CLOSED) return false
  if (
    collaborative.status === CollabStatus.DISCONNECTED
    && isMissingCollabTokenError(collaborative.lastError)
  ) {
    return false
  }
  if (collaborative.status === CollabStatus.SYNCED) return true
  if (collaborative.isCacheReady === true && collaborative.hasCachedContent === true) {
    return true
  }
  return false
}

function isTerminalRestCollab(
  collaborative: RealtimeCollabState,
): boolean {
  if (collaborative.isFallback) return true
  if (collaborative.status === CollabStatus.FORCE_CLOSED) return true
  if (
    collaborative.status === CollabStatus.DISCONNECTED
    && isMissingCollabTokenError(collaborative.lastError)
  ) {
    return true
  }
  return false
}

/**
 * 解析编辑器呈现模式。
 * `hasHydratedLatch`：该 Y.Doc 已成功 hydrate 过一次后保持 realtime，
 * 避免临时断线 / 4401 认证恢复时切回 REST 重挂。
 */
export function resolveCollabEditorPresentation(
  ydoc: Y.Doc | null | undefined,
  collaborative: RealtimeCollabState | null | undefined,
  options?: { hasHydratedLatch?: boolean },
): CollabEditorPresentation {
  // 未接入协作态：沿用 REST 初始内容（非协作宿主 / 测试）
  if (!collaborative) {
    return 'rest'
  }
  if (isTerminalRestCollab(collaborative)) {
    return 'rest'
  }

  const latch = options?.hasHydratedLatch === true
  const hydrated = latch || isCollabContentHydrated(collaborative)

  if (hydrated && ydoc) {
    return 'realtime'
  }

  // 未 hydrate：显示加载态，绝不先挂空 Y.Doc 或 REST 初始内容
  return 'loading'
}

/**
 * 是否用 Y.Doc 驱动 TipTap。
 * 缺 token 的 DISCONNECTED 无法靠 Yjs 恢复外部写入，改走 REST 初始内容。
 * ：首次 hydrate 前返回 false（配合 loading 呈现，避免空 Y.Doc 播种）。
 */
export function shouldUseRealtimeCollabEditor(
  ydoc: Y.Doc | null | undefined,
  collaborative: RealtimeCollabState | null | undefined,
  options?: { hasHydratedLatch?: boolean },
): boolean {
  return resolveCollabEditorPresentation(ydoc, collaborative, options) === 'realtime'
}
