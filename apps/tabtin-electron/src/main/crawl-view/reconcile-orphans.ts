/**
 * reconcile-orphans — 孤儿 View/Run 清理逻辑
 *
 * 从 ipc-handlers.ts 提取，负责扫描无主的 View 和空闲 Run 并清理。
 */

import { getViewFactory } from '../view-factory'
import { getRunSessionManager } from '../run-session/RunSessionManager'
import { createLogger } from './logger'

const log = createLogger('reconcileOrphans')

export interface ReconcileOrphansPayload {
  knownTabIds?: string[]
  knownViewIds?: string[]
  knownWorkspaceIds?: string[]
  reason?: string
}

export interface ReconcileOrphansResult {
  success: boolean
  reason?: string
  totalViews?: number
  destroyedViewIds?: string[]
  endedRunIds?: string[]
  error?: string
}

const IDLE_THRESHOLD_MS = 30_000

export async function reconcileOrphans(
  payload: ReconcileOrphansPayload,
  deps: { getCurrentTabId: () => string | null }
): Promise<ReconcileOrphansResult> {
  const knownTabIds = Array.isArray(payload?.knownTabIds) ? payload.knownTabIds : []
  const knownViewIds = Array.isArray(payload?.knownViewIds) ? payload.knownViewIds : []
  const knownWorkspaceIds = Array.isArray(payload?.knownWorkspaceIds) ? payload.knownWorkspaceIds : []
  const reason = payload?.reason || 'orphan-reconcile'

  const knownViewSet = new Set([...knownTabIds, ...knownViewIds].filter(Boolean))
  const knownWorkspaceSet = new Set(knownWorkspaceIds.filter(Boolean))
  const viewFactory = getViewFactory()

  // E2E-006: 空列表意味着 Renderer 侧不持有任何资源（如 Renderer 崩溃），
  // 此时所有 View 都应被视为孤儿候选，不能跳过清理。
  const isEmptyReconcile = knownViewSet.size === 0 && knownWorkspaceSet.size === 0
  if (isEmptyReconcile) {
    log.warn('⚠️ 已知资源列表为空，视为全量清理:', { reason })
  }

  const shouldCleanupView = (viewId: string, state: any): boolean => {
    if (!viewId) return false
    // 即使在空列表全量清理模式下，仍保护当前活跃的 view
    if (state?.inUse || state?.attachedToMainWindow) return false
    if (viewFactory.getCurrentViewId() === viewId) return false
    if (deps.getCurrentTabId() === viewId) return false
    if (knownViewSet.has(viewId)) return false

    // 🔧 Bug3 修复：即使空列表全量清理，persistent=true 的 View 也不清理
    if (state?.config?.persistent === true) return false

    // 🔧 H-13 修复：autoClose=false 保护必须在 isEmptyReconcile 短路之前，
    // 否则 Renderer 崩溃时空列表全量清理会误销毁 agent-workspace 等视图
    if (state?.config?.autoClose === false) return false

    // 空列表模式：所有非活跃、非持久、非 autoClose=false 的 view 都视为孤儿
    if (isEmptyReconcile) return true

    const metadata = state?.config?.metadata || {}
    const isWorkspaceView = metadata.kind === 'workspace-view' || Boolean(metadata.crawlspaceId)
    if (isWorkspaceView) {
      if (!metadata.crawlspaceId) return false
      if (knownWorkspaceSet.size === 0) return false
      return !knownWorkspaceSet.has(metadata.crawlspaceId)
    }

    const profile = state?.profile
    if (!profile) return false

    // 对于普通 View，保护最近 120 秒内创建或访问过的 View，
    // 避免后台创建但渲染器尚未知晓的 View 被过激清理（P2-07: 冷启动+慢网络场景下 60s 可能不足）
    const lastAccess = state?.lastAccessAt || state?.createdAt || 0
    if (lastAccess && Date.now() - lastAccess < 120_000) return false

    return true
  }

  const allViewIds = viewFactory.getAllViewIds()
  const orphanCandidates: string[] = []
  for (const viewId of allViewIds) {
    const state = viewFactory.getViewState(viewId)
    if (shouldCleanupView(viewId, state)) {
      orphanCandidates.push(viewId)
    }
  }

  log.info('扫描结果:', {
    reason,
    knownTotal: knownViewSet.size,
    knownWorkspaceIds: knownWorkspaceIds.length,
    totalViews: allViewIds.length,
    orphanCandidates: orphanCandidates.length
  })

  const destroyedViewIds: string[] = []
  for (const viewId of orphanCandidates) {
    try {
      await viewFactory.destroyView(viewId, { force: true })
      destroyedViewIds.push(viewId)
    } catch (error) {
      log.warn('destroyView 失败:', {
        viewId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  const runManager = getRunSessionManager()
  const endedRunIds: string[] = []
  const allRuns = runManager.listRuns()
  const now = Date.now()

  for (const run of allRuns) {
    if (!run?.runId) continue
    const runSnapshot = runManager.getRun(run.runId)
    const runViewIds = (runSnapshot?.views || []).map((v: any) => v.viewId).filter(Boolean)
    const hasLiveView = runViewIds.some((vid: string) => viewFactory.hasView(vid))

    if (hasLiveView) continue
    if (now - run.updatedAt < IDLE_THRESHOLD_MS) continue

    try {
      await runManager.endRun(run.runId, { reason: 'orphan-reconcile:empty-run' })
      endedRunIds.push(run.runId)
    } catch (error) {
      log.warn('endRun 失败:', {
        runId: run.runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  log.info('完成:', {
    reason,
    totalViews: allViewIds.length,
    destroyedViews: destroyedViewIds.length,
    endedRuns: endedRunIds.length
  })

  return {
    success: true,
    reason,
    totalViews: allViewIds.length,
    destroyedViewIds,
    endedRunIds
  }
}
