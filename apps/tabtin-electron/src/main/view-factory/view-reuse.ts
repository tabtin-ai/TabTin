/**
 * view-reuse — View 复用与冲突检测
 *
 * 从 ViewFactory.createView 提取，负责检查已有 View、partition/crawlspaceId 冲突、
 * 复用时的 RunSession 注册和性能记录。
 */

import type { ViewFactoryConfig, ViewHandle, ViewEntry, DestroyViewOptions } from './types'
import type { PerformanceCollector } from './PerformanceMetrics'
import { AGENT_BACKGROUND_INTERACTIVE_BOUNDS } from './background-interaction'

type FinalConfig = Omit<Required<ViewFactoryConfig>, 'proxy' | 'antiDetect'> &
  Pick<ViewFactoryConfig, 'proxy' | 'antiDetect'>

type RunManagerLike = {
  registerView: (runId: string, data: any) => void
  registerViewLocked: (runId: string, data: any) => Promise<void>
  /** 通过 viewId 反查绑定的 active runId（同步 Map 查询） */
  getRunIdByView: (viewId: string) => string | undefined
}

type ReuseDeps = {
  views: Map<string, ViewEntry>
  destroyView: (id: string, opts?: DestroyViewOptions) => Promise<void>
  getRunSessionManager: () => RunManagerLike
  performanceCollector: PerformanceCollector
  getStats: () => { inUse: number }
  enableReuse: boolean
  log: (...args: unknown[]) => void
  /** RF04: 查询 VSR 运行时 inUse 状态 */
  getInUse: (id: string) => boolean
  /** RF04: 通过 VSR 设置 inUse */
  setInUse: (id: string, value: boolean) => void
  /** RF04: 通过 VSR 更新 lastAccessTime */
  touchView: (id: string) => void
}

/**
 * 尝试复用已有 View。返回 ViewHandle 表示复用成功；返回 null 表示需要新建。
 */
export async function resolveViewReuse(
  finalConfig: FinalConfig,
  deps: ReuseDeps
): Promise<ViewHandle | null> {
  const existing = deps.views.get(finalConfig.id)
  if (!existing) return null

  deps.log('[ViewFactory] View 已存在，返回现有实例:', finalConfig.id)
  deps.log('[ViewFactory] 复用诊断:', {
    id: finalConfig.id,
    requested: {
      profile: finalConfig.profile,
      partition: finalConfig.partition,
      crawlspaceId: finalConfig.metadata?.crawlspaceId,
      runId: finalConfig.runId,
      source: finalConfig.metadata?.source || finalConfig.metadata?.createdBy
    },
    existing: {
      profile: existing.profile,
      partition: existing.config?.partition,
      crawlspaceId: existing.config?.metadata?.crawlspaceId,
      runId: existing.config?.runId,
      source: existing.config?.metadata?.source || existing.config?.metadata?.createdBy
    }
  })

  const requestedPartition = finalConfig.partition ?? null
  const existingPartition = existing.config?.partition ?? null
  const requestedCrawlspaceId = (finalConfig.metadata?.crawlspaceId as string) ?? null
  const existingCrawlspaceId = (existing.config?.metadata?.crawlspaceId as string) ?? null

  if (requestedPartition !== existingPartition || requestedCrawlspaceId !== existingCrawlspaceId) {
    const existingInUse = deps.getInUse(finalConfig.id)
    const partitionMismatch = requestedPartition !== existingPartition
    const crawlspaceMismatch = requestedCrawlspaceId !== existingCrawlspaceId
    deps.log('[ViewFactory] 复用冲突：partition/crawlspaceId 不一致', {
      id: finalConfig.id,
      requested: { partition: requestedPartition, crawlspaceId: requestedCrawlspaceId },
      existing: {
        partition: existingPartition, crawlspaceId: existingCrawlspaceId,
        inUse: existingInUse, attachedToMainWindow: existing.attachedToMainWindow,
      },
      partitionMismatch, crawlspaceMismatch,
    })
    // 本地化退役 Wave 3：统一 partition 不一致的处理路径。
    //
    // 历史行为：仅在 `!existingInUse && !attachedToMainWindow` 时 destroy + 重建，
    // 否则抛 "view 复用被拒绝" 错误。这条分支是"用户改 env 绑定后已附着到主窗的
    // view 焊死红条"的根因 —— 用户最常踩的就是显示中的 view，恰恰落到 throw
    // 分支。
    //
    // 现在：partition 不一致 = 合法的 env 变更（ipc-handlers 已先发 toast），
    // 默认执行销毁 + 重建。crawlspaceId 不一致仍视为数据完整性错误（同一
    // tabId 被两个 workspace 抢用），保留抛错路径。
    //
    // L-W3-9（Wave 3 复核）：对称 `crawl-view/ipc-handlers.ts` 的 B1 守卫——
    // 当 view 绑定到 active run 时，宁可继续用旧 partition 完成本次复用，
    // 也不主动 destroy 打断 Agent 任务。run 结束后 viewToRun 解除，
    // 下一次 show 会再次走复用路径，partition 仍不一致则那时再重建。
    // 当前 Agent 不会主动改 partition，故只是预防性的对称守卫；走 createView
    // 路径（Agent / action-tools）和走 ipc-handlers showEmbeddedView 路径
    // 都不会半路打断 run。
    if (partitionMismatch && !crawlspaceMismatch) {
      const activeRunId = deps.getRunSessionManager().getRunIdByView(finalConfig.id)
      if (activeRunId) {
        // dogfood grep 关键字：partition reuse defer
        deps.log('[ViewFactory] partition reuse defer: 检测到 active run, 复用旧 partition 不 destroy', {
          viewId: finalConfig.id,
          requestedPartition,
          existingPartition,
          runId: activeRunId,
        })
        // 跳过 destroy，下面的 reusedEntry 仍指向旧 view，继续走复用成功路径。
      } else if (!deps.views.has(finalConfig.id)) {
        deps.log('[ViewFactory] TOCTOU: View 已被并发销毁，跳过重复 destroy:', finalConfig.id)
      } else {
        await deps.destroyView(finalConfig.id, { force: true })
      }
    } else {
      // crawlspaceId 不一致（含同时 partition 也不一致的混合场景）→ 数据完整性异常
      throw new Error(`[ViewFactory] view 复用被拒绝: id=${finalConfig.id} crawlspaceId 不一致`)
    }
  }

  const reusedEntry = deps.views.get(finalConfig.id)
  if (!reusedEntry) return null

  if (!deps.enableReuse) {
    deps.log('[ViewFactory] enableReuse=false, 销毁旧 View 以重建:', finalConfig.id)
    if (deps.views.has(finalConfig.id)) {
      await deps.destroyView(finalConfig.id, { force: true })
    }
    return null
  }

  deps.touchView(finalConfig.id)
  deps.setInUse(finalConfig.id, true)

  if (!reusedEntry.view) {
    deps.log('[ViewFactory] 复用失败：entry 缺少 view 实例', finalConfig.id)
    return null
  }

  if (finalConfig.runId) {
    const manager = deps.getRunSessionManager()
    await manager.registerViewLocked(finalConfig.runId, {
      viewId: finalConfig.id,
      profile: finalConfig.profile,
      partition: finalConfig.partition,
      userAgent: finalConfig.userAgent,
      proxy: finalConfig.proxy,
      metadata: finalConfig.metadata,
      createdAt: reusedEntry.createdAt,
      inUse: true
    })
  }

  if (finalConfig.metadata?.agentBackgroundInteractive === true) {
    reusedEntry.config.runId = finalConfig.runId
    reusedEntry.config.metadata = finalConfig.metadata
    reusedEntry.config.bounds = finalConfig.bounds

    const currentBounds = reusedEntry.view.getBounds()
    if (currentBounds.x < 0 && currentBounds.y < 0) {
      reusedEntry.view.setBounds(AGENT_BACKGROUND_INTERACTIVE_BOUNDS)
    }
  }

  return {
    id: finalConfig.id,
    view: reusedEntry.view,
    reused: true,
    profile: finalConfig.profile,
    config: finalConfig
  }
}
