/**
 * 将 ViewFactory / VSR 的 inUse 与「可回收空闲」产品边界对齐：
 * 预览或脱屏、且当前未激活 → inUse=false；激活 → inUse=true。
 *
 * 与性能监控「一键回收空闲 Browser」文案一致；不改动主窗口前台普通标签。
 *
 * 依赖通过 configureSyncViewInUse 注入，禁止裸 require——electron-vite 主进程
 * 打成 ESM .mjs 后相对路径 require 会静默失败（同 W4.6）。
 */

import { createLogger } from '../logger'
import type { CrawlspaceContextSnapshot } from './context-types'

const log = createLogger('SyncViewInUse')

export type ViewInUseDecision = 'mark' | 'release' | 'keep'

export type SyncViewInUseHub = {
  getSnapshot: (crawlspaceId: string) => CrawlspaceContextSnapshot
  getAllSnapshots: () => CrawlspaceContextSnapshot[]
}

export type SyncViewInUseViewFactory = {
  hasView: (id: string) => boolean
  getViewState: (id: string) => {
    inUse?: boolean
    attachedToMainWindow?: boolean
    config?: { metadata?: Record<string, unknown> }
  } | undefined
  markViewInUse: (id: string) => void
  releaseViewInUse: (id: string) => void
}

export type SyncViewInUseDeps = {
  getHub: () => SyncViewInUseHub
  getViewFactory: () => SyncViewInUseViewFactory
  /** RunSession 对 View 的实时占用；undefined 表示该 View 不归运行会话管理。 */
  getRuntimeViewActive?: (viewId: string) => boolean | undefined
}

let configuredDeps: SyncViewInUseDeps | null = null

/** 应用启动 / ViewFactory 就绪后注入一次；可重复调用覆盖（测试用）。 */
export function configureSyncViewInUse(deps: SyncViewInUseDeps): void {
  configuredDeps = deps
}

/** 测试辅助：清空注入。 */
export function resetSyncViewInUseForTests(): void {
  configuredDeps = null
}

export function decideViewInUseState(input: {
  isActive: boolean
  isClosing?: boolean
  isPreview: boolean
  attachedToMainWindow: boolean
  runtimeActive?: boolean
}): ViewInUseDecision {
  if (input.isClosing) return 'keep'
  const isOffscreen = input.isPreview || !input.attachedToMainWindow
  if (isOffscreen && input.runtimeActive !== undefined) {
    return input.runtimeActive ? 'mark' : 'release'
  }
  if (input.isActive) return 'mark'
  // 预览 / 脱屏未激活 → 空闲（可回收）；主窗口已挂载普通标签即使后台也 mark，
  // 避免 create 先 release、再 attach 后 keep 留下 inUse=false 被 idle cleanup 误清。
  if (input.isPreview || !input.attachedToMainWindow) return 'release'
  return 'mark'
}

function resolveIsPreview(
  hubIsPreview: boolean | undefined,
  metadata: Record<string, unknown> | undefined,
): boolean {
  if (hubIsPreview === true) return true
  if (!metadata) return false
  return metadata.isPreview === true || metadata.kind === 'preview-view'
}

function resolveDeps(deps?: SyncViewInUseDeps): SyncViewInUseDeps | null {
  return deps ?? configuredDeps
}

/**
 * 按 crawlspace 快照同步该空间内各 View 的 inUse。
 * 生产路径依赖 configureSyncViewInUse；单测可直接传 deps。
 */
export function syncCrawlspaceViewInUseState(
  crawlspaceId: string,
  deps?: SyncViewInUseDeps,
): void {
  if (!crawlspaceId) return

  const resolved = resolveDeps(deps)
  if (!resolved) {
    log.debug('syncCrawlspaceViewInUseState: 未 configure，跳过')
    return
  }

  let hub: SyncViewInUseHub
  let viewFactory: SyncViewInUseViewFactory
  try {
    hub = resolved.getHub()
    viewFactory = resolved.getViewFactory()
  } catch (error) {
    log.debug('syncCrawlspaceViewInUseState: 实例未就绪，跳过', error)
    return
  }

  const snapshot = hub.getSnapshot(crawlspaceId)
  for (const view of snapshot.views) {
    if (!viewFactory.hasView(view.viewId)) continue
    const state = viewFactory.getViewState(view.viewId)
    if (!state) continue

    const metadata = (state.config?.metadata || {}) as Record<string, unknown>
    let runtimeActive: boolean | undefined
    try {
      runtimeActive = resolved.getRuntimeViewActive?.(view.viewId)
    } catch (error) {
      log.debug('查询 RunSession View 占用失败，沿用 Crawlspace 状态:', view.viewId, error)
    }
    const decision = decideViewInUseState({
      isActive: Boolean(view.isActive),
      isClosing: Boolean(view.isClosing),
      isPreview: resolveIsPreview(view.isPreview, metadata),
      attachedToMainWindow: Boolean(state.attachedToMainWindow),
      runtimeActive,
    })

    if (decision === 'mark') {
      if (!state.inUse) {
        viewFactory.markViewInUse(view.viewId)
      }
    } else if (decision === 'release') {
      if (state.inUse) {
        viewFactory.releaseViewInUse(view.viewId)
      }
    }
  }
}

/** 打开性能监控等场景：自愈所有 crawlspace 内卡住的 inUse。 */
export function syncAllCrawlspaceViewInUseState(deps?: SyncViewInUseDeps): void {
  const resolved = resolveDeps(deps)
  if (!resolved) {
    log.debug('syncAllCrawlspaceViewInUseState: 未 configure，跳过')
    return
  }

  let hub: SyncViewInUseHub
  try {
    hub = resolved.getHub()
  } catch (error) {
    log.debug('syncAllCrawlspaceViewInUseState: Hub 未就绪，跳过', error)
    return
  }

  for (const snapshot of hub.getAllSnapshots()) {
    syncCrawlspaceViewInUseState(snapshot.crawlspaceId, resolved)
  }
}
