import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { getRunSessionManager } from './RunSessionManager'
import { guardedHandle } from '../utils/guarded-handle'
import { createLogger } from '../logger'

const log = createLogger('RunSessionIPC')

const ADD_EVENT_RATE_LIMIT = 100
const ADD_EVENT_RATE_WINDOW_MS = 1000
const RATE_BUCKET_CLEANUP_INTERVAL_MS = 60_000
const RATE_BUCKET_STALE_MS = 30_000

type RateBucket = { tokens: number; lastRefill: number }
const perSenderBuckets = new Map<number, RateBucket>()

let _bucketCleanupTimer: ReturnType<typeof setInterval> | null = null

function ensureBucketCleanup(): void {
  if (_bucketCleanupTimer) return
  _bucketCleanupTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, bucket] of perSenderBuckets) {
      if (now - bucket.lastRefill > RATE_BUCKET_STALE_MS) {
        perSenderBuckets.delete(id)
      }
    }
    if (perSenderBuckets.size === 0 && _bucketCleanupTimer) {
      clearInterval(_bucketCleanupTimer)
      _bucketCleanupTimer = null
    }
  }, RATE_BUCKET_CLEANUP_INTERVAL_MS)
  _bucketCleanupTimer.unref?.()
}

function checkAddEventRateLimit(senderId: number): boolean {
  const now = Date.now()
  let bucket = perSenderBuckets.get(senderId)
  if (!bucket) {
    bucket = { tokens: ADD_EVENT_RATE_LIMIT, lastRefill: now }
    perSenderBuckets.set(senderId, bucket)
    ensureBucketCleanup()
  }
  const elapsed = now - bucket.lastRefill
  if (elapsed >= ADD_EVENT_RATE_WINDOW_MS) {
    bucket.tokens = ADD_EVENT_RATE_LIMIT
    bucket.lastRefill = now
  }
  if (bucket.tokens <= 0) {
    return false
  }
  bucket.tokens--
  return true
}

/**
 * Run/Session 相关 IPC
 * - 查询事件（供前端/后端转发）
 * - 查询 run 快照
 * 说明：run 的创建/注册由调用方在业务流程中触发（open_tab/registerView 等）
 */
export function registerRunSessionIpcHandlers(): void {
  const manager = getRunSessionManager()

  // 🆕 创建 Run
  guardedHandle('run-session:create', (_event, runId?: string, sessionId?: string, profile?: string) => {
    try {
      const session = manager.createRun(runId, sessionId, profile)
      log.info('Run 已创建', { runId: session.runId, profile: profile ?? null })
      return {
        success: true,
        runId: session.runId,
        sessionId: session.sessionId,
        profile: session.profile
      }
    } catch (error) {
      log.error('创建 Run 失败', { runId, profile }, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  guardedHandle('run-session:get', (_event, runId: string) => {
    return manager.getRun(runId)
  })

  //  Phase 3（keepalive）：查询某 view 当前是否有进行中的 Agent run。
  // 判定 = viewToRun 有映射 && run 仍存活（endRun 后 getRun 返 null，天然回落）。
  // webview 容器切走 tab 时据此选 keepalive（不节流）/ throttle（节流）档。
  guardedHandle('run-session:hasActiveRunForView', (_event, viewId: string) => {
    if (!viewId || typeof viewId !== 'string') {
      return { active: false }
    }
    const runId = manager.getRunIdByView(viewId)
    const active = Boolean(runId && manager.getRun(runId))
    return { active, runId: active ? runId : undefined }
  })

  guardedHandle(
    'run-session:addEvent',
    (event: IpcMainInvokeEvent, payload: { runId?: string; viewId?: string; type: string; data?: any; timestamp?: number }) => {
      if (!payload || !payload.type) {
        return { success: false, error: 'invalid payload' }
      }
      if (!checkAddEventRateLimit(event.sender.id)) {
        return { success: false, error: 'rate limit exceeded' }
      }
      manager.addObservation({
        runId: payload.runId,
        viewId: payload.viewId,
        type: payload.type,
        data: payload.data,
        timestamp: payload.timestamp
      })
      return { success: true }
    }
  )

  guardedHandle(
    'run-session:registerView',
    async (_event: IpcMainInvokeEvent, runId: string, viewInfo: { viewId: string; profile?: string; partition?: string; userAgent?: string; proxy?: any; metadata?: Record<string, any> }) => {
      if (!runId || !viewInfo?.viewId) {
        return { success: false, error: 'runId or viewId missing' }
      }
      // TT-50: 配额检查前置 — 在 registerViewLocked 之前检查 Run 和 View 配额，
      // 避免 auto-create Run 的副作用绕过配额路径
      const quotaCheck = manager.checkQuotaForNewView(runId, true)
      if (!quotaCheck.allowed) {
        log.warn('registerView 配额拒绝', { runId, viewId: viewInfo.viewId, reason: quotaCheck.reason })
        return { success: false, error: quotaCheck.reason }
      }
      try {
        await manager.registerViewLocked(runId, {
          viewId: viewInfo.viewId,
          profile: viewInfo.profile,
          partition: viewInfo.partition,
          userAgent: viewInfo.userAgent,
          proxy: viewInfo.proxy,
          metadata: viewInfo.metadata,
          createdAt: Date.now(),
          inUse: true
        })
        return { success: true }
      } catch (error) {
        log.error('registerView 失败', { runId, viewId: viewInfo.viewId }, error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle('run-session:setActiveView', (_event: IpcMainInvokeEvent, runId: string, viewId?: string | null) => {
    manager.setActiveView(runId, viewId ?? null)
    return { success: true }
  })

  // destroyViews：已废弃。RunSessionManager.endRun 仅依据各 View 的 autoClose 决定是否销毁；传 true 仅影响 reason 标记（destroyViews-legacy）。
  guardedHandle('run-session:endRun', async (_event: IpcMainInvokeEvent, runId: string, options?: { reason?: string; destroyViews?: boolean }) => {
    const reason = options?.reason ?? (options?.destroyViews ? 'destroyViews-legacy' : undefined)
    await manager.endRun(runId, { reason })
    return { success: true }
  })

  // open_tab：创建 View 并注册/标记 active，支持传 runId/partition/UA/代理
  guardedHandle(
    'run-session:openTab',
    async (_event: IpcMainInvokeEvent, payload: {
      runId?: string
      id?: string
      url?: string
      profile?: string
      partition?: string
      userAgent?: string
      proxy?: any
      metadata?: Record<string, any>
      fallbackReason?: string
      keepAlive?: boolean
      displayMode?: 'hidden' | 'embedded' | 'windowed'
      showInSidebar?: boolean
      notifyRenderer?: boolean
    }) => {
      if (process.env.TABTIN_RUN_SESSION_TAB_API !== '1') {
        return { success: false, error: 'run-session:openTab 已禁用 (TABTIN_RUN_SESSION_TAB_API=0)' }
      }
      const metadata = payload?.metadata || {}
      const isWorkspaceView = Boolean(metadata?.crawlspaceId || metadata?.kind === 'workspace-view')
      if (isWorkspaceView) {
        return { success: false, error: 'workspace view 不允许通过 run-session:openTab 创建' }
      }
      return manager.openTab({
        ...payload,
        keepAlive: payload.keepAlive ?? true,
        displayMode: payload.displayMode ?? 'hidden',
        showInSidebar: payload.showInSidebar ?? false,
        notifyRenderer: payload.notifyRenderer ?? false
      })
    }
  )

  // 🆕 switch_tab：仅设置 active，并请求显示
  guardedHandle(
    'run-session:switchTab',
    async (_event: IpcMainInvokeEvent, payload: { runId?: string; viewId: string; bounds?: any }) => {
      if (process.env.TABTIN_RUN_SESSION_TAB_API !== '1') {
        return { success: false, error: 'run-session:switchTab 已禁用 (TABTIN_RUN_SESSION_TAB_API=0)' }
      }
      try {
        const { getViewFactory } = await import('../view-factory')
        const viewFactory = getViewFactory()
        const state = viewFactory.getViewState(payload.viewId)
        const metadata = state?.config?.metadata || {}
        if (metadata?.crawlspaceId || metadata?.kind === 'workspace-view') {
          return { success: false, error: 'workspace view 不允许通过 run-session:switchTab 切换' }
        }
      } catch {
        // ignore
      }
      return manager.switchTab(payload)
    }
  )

  // 🆕 close_tab：销毁视图并解除 run 映射
  guardedHandle(
    'run-session:closeTab',
    async (_event: IpcMainInvokeEvent, payload: { runId?: string; viewId: string; force?: boolean }) => {
      if (process.env.TABTIN_RUN_SESSION_TAB_API !== '1') {
        return { success: false, error: 'run-session:closeTab 已禁用 (TABTIN_RUN_SESSION_TAB_API=0)' }
      }
      try {
        const { getViewFactory } = await import('../view-factory')
        const viewFactory = getViewFactory()
        const state = viewFactory.getViewState(payload.viewId)
        const metadata = state?.config?.metadata || {}
        if (metadata?.crawlspaceId || metadata?.kind === 'workspace-view') {
          return { success: false, error: 'workspace view 不允许通过 run-session:closeTab 关闭' }
        }
      } catch {
        // ignore
      }
      return manager.closeTab(payload)
    }
  )
}

export function unregisterRunSessionIpcHandlers(): void {
  ipcMain.removeHandler('run-session:create')
  ipcMain.removeHandler('run-session:get')
  ipcMain.removeHandler('run-session:hasActiveRunForView')
  ipcMain.removeHandler('run-session:addEvent')
  ipcMain.removeHandler('run-session:registerView')
  ipcMain.removeHandler('run-session:setActiveView')
  ipcMain.removeHandler('run-session:endRun')
  ipcMain.removeHandler('run-session:openTab')
  ipcMain.removeHandler('run-session:switchTab')
  ipcMain.removeHandler('run-session:closeTab')
}
