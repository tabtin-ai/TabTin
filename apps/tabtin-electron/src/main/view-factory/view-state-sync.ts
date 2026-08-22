/**
 * view-state-sync — View 状态同步（VSR 读写 + crawlspace 元数据同步）
 *
 * 从 ViewFactory.ts 提取，纯函数设计：不持有状态，所有依赖通过参数注入。
 *
 * 职责：
 * - RF04 VSR 运行时状态访问器（getViewInUse / setViewInUse / touchView）
 * - ViewEntry + VSR 组合视图（composeViewState）
 * - VSR → Crawlspace 元数据同步（handleViewStateUpdated）
 */

import type { ViewEntry, ViewState } from './types'
import type { ViewState as RegistryViewState } from '../webcontents/ViewStateRegistry'
import { syncWorkspaceViewMetadata } from '../crawlspace/view-metadata-sync'
import { getCrawlspaceContextHub } from '../crawlspace/CrawlspaceContextHub'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ViewStateRegistryLike = {
  hasView(id: string): boolean
  getState(id: string): RegistryViewState | undefined
  updateState(id: string, updates: any): void
  touch(id: string): void
}

// ---------------------------------------------------------------------------
// RF04: VSR 运行时状态访问器（单一来源）
// ---------------------------------------------------------------------------

/** 从 VSR 读取 inUse，VSR 未注册时返回 false */
export function getViewInUse(id: string, getVSR: () => ViewStateRegistryLike): boolean {
  try {
    return getVSR().getState(id)?.inUse ?? false
  } catch {
    return false
  }
}

/** 向 VSR 写入 inUse */
export function setViewInUse(id: string, value: boolean, getVSR: () => ViewStateRegistryLike): void {
  try {
    const vsr = getVSR()
    if (vsr.hasView(id)) {
      vsr.updateState(id, { inUse: value } as any)
    }
  } catch {
    // VSR 尚未初始化
  }
}

/** 向 VSR 更新 lastAccessTime */
export function touchView(id: string, getVSR: () => ViewStateRegistryLike): void {
  try {
    const vsr = getVSR()
    if (vsr.hasView(id)) {
      vsr.touch(id)
    }
  } catch {
    // VSR 尚未初始化
  }
}

/**
 * 刷新所有 View 的 lastAccessTime，防止批量误清理。
 *
 * 典型使用场景：系统唤醒后（合盖过夜），所有 View 的 lastAccessTime 远超 idle 阈值，
 * 首个清理周期会批量 discard 全部标签。调用此方法可给每个 View 续期一个新的 idle 窗口。
 */
export function touchAllViews(
  views: Map<string, ViewEntry>,
  getVSR: () => ViewStateRegistryLike,
  log: (...args: any[]) => void,
): void {
  let vsr: ViewStateRegistryLike
  try {
    vsr = getVSR()
  } catch {
    return
  }
  for (const [id, entry] of views.entries()) {
    if (entry.discarded) continue
    try {
      if (vsr.hasView(id)) {
        vsr.touch(id)
      }
    } catch {
      // ignore
    }
  }
  log('[ViewFactory] 已刷新所有 View 的 lastAccessTime')
}

// ---------------------------------------------------------------------------
// ViewEntry + VSR 组合视图
// ---------------------------------------------------------------------------

/** 组合 ViewEntry + VSR → ViewState（公共 API 用） */
export function composeViewState(
  id: string,
  views: Map<string, ViewEntry>,
  getVSR: () => ViewStateRegistryLike,
): ViewState | undefined {
  const entry = views.get(id)
  if (!entry) return undefined

  let url = entry.config.url || ''
  let lastAccessAt = entry.createdAt
  let inUse = false

  try {
    const vsrState = getVSR().getState(id)
    if (vsrState) {
      url = vsrState.url
      lastAccessAt = vsrState.lastAccessTime
      inUse = vsrState.inUse
    }
  } catch {
    // VSR 尚未初始化，使用默认值
  }

  return { ...entry, url, lastAccessAt, inUse }
}

// ---------------------------------------------------------------------------
// VSR → Crawlspace 元数据同步
// ---------------------------------------------------------------------------

/**
 * 处理 VSR view:updated 事件，将 title/url/favicon/status 变化同步到 Crawlspace。
 */
export function handleViewStateUpdated(
  payload: {
    id: string
    state: RegistryViewState
    updates: Partial<RegistryViewState>
  },
  views: Map<string, ViewEntry>,
): void {
  const { id, state: vsrState, updates } = payload
  const metadata = vsrState.metadata || {}
  const crawlspaceId = metadata.crawlspaceId || views.get(id)?.config?.metadata?.crawlspaceId
  if (!crawlspaceId) return

  const metaUpdates: { title?: string; url?: string; favicon?: string | null } = {}
  if (Object.prototype.hasOwnProperty.call(updates, 'title')) {
    metaUpdates.title = vsrState.title
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'url')) {
    metaUpdates.url = vsrState.url
  }
  if (Object.prototype.hasOwnProperty.call(updates, 'favicon')) {
    metaUpdates.favicon = vsrState.favicon ?? null
  }

  if (Object.keys(metaUpdates).length > 0) {
    syncWorkspaceViewMetadata({
      viewId: id,
      crawlspaceId,
      ...metaUpdates,
    })
  }

  if (updates.status !== undefined) {
    if (updates.status === 'error') {
      const errorDesc = vsrState.lastErrorDescription || 'Page failed to load'
      getCrawlspaceContextHub().setViewError(crawlspaceId, id, { errorDescription: errorDesc })
    } else {
      getCrawlspaceContextHub().setViewLoading(crawlspaceId, id, updates.status === 'loading')
    }
  }
}
