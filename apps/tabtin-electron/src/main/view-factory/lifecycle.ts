/**
 * lifecycle — View 生命周期管理（清理 / 销毁 / LRU / Preload 回收）
 *
 * 从 ViewFactory.ts 提取，纯函数设计：不持有状态，所有依赖通过参数注入。
 */

import { type WebContentsView, powerMonitor } from 'electron'
import type { ViewEntry, DestroyViewOptions } from './types'
import { getMemoryPressure, type PerformanceCollector } from './PerformanceMetrics'
import {
  cleanupRegisteredSessionPreloads,
  type SessionPreloadRegistry,
} from './session-preload-registry'
import { getViewStateRegistry } from '../webcontents/ViewStateRegistry'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupContext {
  views: Map<string, ViewEntry>
  idleTimeout: number
  maxPreviewViews: number
  destroyView: (id: string, options?: DestroyViewOptions) => Promise<void>
  log: (...args: unknown[]) => void
  performanceCollector: PerformanceCollector
}

export interface ExternalHandlers {
  closeEngineBrowserForView?: (id: string) => Promise<void>
  /** INFRA-014: 销毁 TabPhone view 时停止对应的 scrcpy 镜像，防止 Android 设备上残留 scrcpy-server */
  stopTabPhoneMirrorForView?: (id: string) => Promise<void>
  /** 创建网页 view 时挂载 CDP 网络/console 捕获（从加载起就抓，历史留本地缓冲） */
  enableNetworkCaptureForView?: (id: string) => Promise<void>
  /** 销毁 view 时释放 CDP 网络/console 捕获缓冲，避免泄漏 */
  disableNetworkCaptureForView?: (id: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// Quota reclaim profile whitelist
// ---------------------------------------------------------------------------

export const QUOTA_RECLAIM_PROFILES = [
  'agent-workspace',
  'background-task',
  'temporary-preview',
] as const

export function isQuotaReclaimableProfile(profile: string): boolean {
  return (QUOTA_RECLAIM_PROFILES as readonly string[]).includes(profile)
}

// ---------------------------------------------------------------------------
// cleanupIdleViews + LRU
// ---------------------------------------------------------------------------

export interface CleanupOptions {
  /** 跳过系统活跃检测（配额紧急清理路径使用） */
  bypassIdleCheck?: boolean
  /** 强制使用完全销毁模式（不 discard），立即释放 views Map 槽位 */
  forceFullDestroy?: boolean
  /** 若设置，仅这些 profile 可被清理；未设置则保持旧行为（兼容非配额路径） */
  allowedProfiles?: ReadonlyArray<string>
}

/**
 * RF04: 清理空闲 View + 孤儿 View（VSR 作为单一运行时状态源）。
 *
 * 流程：
 *   1. 通过 VSR 查询 inUse / lastAccessTime，决定哪些 View 空闲超时
 *   2. LRU 淘汰超上限的预览 View（同样通过 VSR 查询）
 *   3. 调用 VSR.cleanupOrphans() 清理 WebContents 已销毁的残留条目
 *   4. 内存压力检测：critical 强制清理，warning 加速清理
 */
export async function cleanupIdleViews(ctx: CleanupContext, options?: CleanupOptions): Promise<void> {
  if (!options?.bypassIdleCheck) {
    try {
      const systemIdleSeconds = powerMonitor.getSystemIdleTime()
      if (systemIdleSeconds < 60) {
        return
      }
    } catch {
      // powerMonitor 在 app ready 之前不可用，静默跳过
    }
  }

  const pressure = getMemoryPressure()
  const effectiveIdleTimeout = pressure.level === 'warning'
    ? Math.min(ctx.idleTimeout, 60_000)
    : ctx.idleTimeout

  if (pressure.level !== 'normal') {
    ctx.log(`[ViewFactory] 内存压力: ${pressure.level} (${pressure.heapUsedMB.toFixed(0)}MB / ${pressure.heapTotalMB.toFixed(0)}MB, ${(pressure.usageRatio * 100).toFixed(1)}%)`)
  }

  const startTime = Date.now()
  const now = Date.now()
  const toClean: string[] = []

  let vsr: ReturnType<typeof getViewStateRegistry> | null = null
  try {
    vsr = getViewStateRegistry()
  } catch {
    // VSR 尚未初始化
  }

  for (const [id, entry] of ctx.views.entries()) {
    if (!vsr) break

    if (entry.discarded) continue
    if (isTerminalView(entry)) continue

    if (options?.allowedProfiles && options.allowedProfiles.length > 0) {
      const profile = entry.config.profile
      if (!options.allowedProfiles.includes(profile)) continue
    }

    const vsrState = vsr.getState(id)
    if (!vsrState) continue
    if (vsrState.inUse) continue

    try {
      const wc = entry.view?.webContents
      if (wc && !wc.isDestroyed()) {
        if (wc.isCurrentlyAudible()) continue
        if (wc.isLoading()) continue
      }
    } catch {
      // webContents 可能已部分销毁
    }

    // critical 压力下跳过 idle 时间检查，清理所有非 inUse View
    if (pressure.level === 'critical' || now - vsrState.lastAccessTime > effectiveIdleTimeout) {
      toClean.push(id)
    }
  }

  if (toClean.length > 0) {
    const useFullDestroy = options?.forceFullDestroy || pressure.level === 'critical'
    ctx.log(`[ViewFactory] 清理空闲 View (${useFullDestroy ? '完全销毁' : 'discard'}):`, toClean)
    for (const id of toClean) {
      const vsrState = vsr?.getState(id)
      if (vsrState?.inUse) {
        ctx.log('[ViewFactory] View 已被标记使用中，跳过销毁:', id)
        continue
      }
      await ctx.destroyView(id, { force: true, discard: !useFullDestroy })
    }
    const duration = Date.now() - startTime
    ctx.performanceCollector.recordCleanup(duration, toClean.length)
  }

  // LRU：限制预览 View 总数
  const previewViews = Array.from(ctx.views.entries())
    .filter(([id, entry]) => {
      const metadata = entry.config.metadata || {}
      const isPreview = metadata.isPreview === true || metadata.kind === 'preview-view'
      const inUse = vsr?.getState(id)?.inUse ?? false
      return isPreview && !inUse
    })
    .sort((a, b) => {
      const aTime = vsr?.getState(a[0])?.lastAccessTime ?? a[1].createdAt
      const bTime = vsr?.getState(b[0])?.lastAccessTime ?? b[1].createdAt
      return bTime - aTime
    })

  if (previewViews.length > ctx.maxPreviewViews) {
    const toEvict = previewViews.slice(ctx.maxPreviewViews)
    if (toEvict.length > 0) {
      ctx.log('[ViewFactory] LRU 清理预览 View:', toEvict.map(([id]) => id))
      for (const [id] of toEvict) {
        try {
          const vsrState = vsr?.getState(id)
          if (vsrState?.inUse) {
            ctx.log('[ViewFactory] LRU View 已被标记使用中，跳过销毁:', id)
            continue
          }
          await ctx.destroyView(id, { force: true })
        } catch (error) {
          ctx.log('[ViewFactory] LRU 清理失败:', id, error)
        }
      }
      const duration = Date.now() - startTime
      ctx.performanceCollector.recordCleanup(duration, toEvict.length)
    }
  }

  // RF04: 驱动 VSR 孤儿清理（WebContents 已销毁的残留条目）
  if (vsr) {
    const orphanIds = vsr.cleanupOrphans()
    for (const id of orphanIds) {
      if (ctx.views.has(id)) {
        ctx.log('[ViewFactory] 🧹 VSR 孤儿 View 残留在 views Map 中，移除:', id)
        ctx.views.delete(id)
      }
    }
  }

  // 清理过期的 discarded entries，防止 views Map 无限膨胀
  const DISCARD_TTL = 24 * 60 * 60_000
  const MAX_DISCARDED = 50
  const discardedEntries: [string, ViewEntry][] = []
  for (const [id, entry] of ctx.views.entries()) {
    if (entry.discarded) discardedEntries.push([id, entry])
  }
  if (discardedEntries.length > 0) {
    let purged = 0
    for (const [id, entry] of discardedEntries) {
      if (now - entry.createdAt > DISCARD_TTL) {
        ctx.views.delete(id)
        purged++
      }
    }
    // 超过上限的按创建时间 LRU 淘汰
    const remaining = discardedEntries.filter(([id]) => ctx.views.has(id))
    if (remaining.length > MAX_DISCARDED) {
      remaining.sort((a, b) => a[1].createdAt - b[1].createdAt)
      const excess = remaining.length - MAX_DISCARDED
      for (let i = 0; i < excess; i++) {
        ctx.views.delete(remaining[i][0])
        purged++
      }
    }
    if (purged > 0) {
      ctx.log(`[ViewFactory] 🧹 清理了 ${purged} 个过期 discarded entries`)
    }
  }
}

// ---------------------------------------------------------------------------
// destroyWebContents
// ---------------------------------------------------------------------------

/**
 * 安全销毁 WebContents：非持久 View 做快速 session 清理（cookies + cache）。
 */
export async function destroyWebContents(
  view: WebContentsView,
  state: ViewEntry | undefined,
  log: (...args: unknown[]) => void,
): Promise<void> {
  try {
    const webContents = view.webContents
    if (webContents && !webContents.isDestroyed()) {
      const isPersistent = state?.config?.persistent ?? false
      if (!isPersistent) {
        try {
          const { quickCleanup } = await import('../services/SessionCleanupService')
          await quickCleanup(webContents)
        } catch {
          // 静默：View 可能已部分销毁
        }
      }
      webContents.removeAllListeners()
    }
  } catch (error) {
    log('[ViewFactory] ⚠️  清理 WebContents 失败:', error)
  }
}

// ---------------------------------------------------------------------------
// closeBrowserForView
// ---------------------------------------------------------------------------

/**
 * 关闭 View 对应的 Browser/CDP 会话。
 */
export async function closeBrowserForView(
  id: string,
  handlers: ExternalHandlers,
  log: (...args: unknown[]) => void,
): Promise<void> {
  log('[ViewFactory] 🔚 关闭 View 的 Browser/CDP 会话:', id)
  try {
    if (handlers.closeEngineBrowserForView) {
      await handlers.closeEngineBrowserForView(id)
      log('[ViewFactory] ✅ Browser/CDP 会话已关闭')
    }

    // INFRA-014: 若为 TabPhone view，停止对应的 scrcpy 镜像会话
    if (handlers.stopTabPhoneMirrorForView) {
      try {
        await handlers.stopTabPhoneMirrorForView(id)
        log('[ViewFactory]   ✅ TabPhone 镜像会话已清理')
      } catch (error) {
        log('[ViewFactory]   ⚠️  清理 TabPhone 镜像失败:', error)
      }
    }

    // 释放 CDP 网络/console 捕获缓冲（创建即挂的对称清理，避免泄漏）
    if (handlers.disableNetworkCaptureForView) {
      try {
        await handlers.disableNetworkCaptureForView(id)
        log('[ViewFactory]   ✅ 网络捕获缓冲已释放')
      } catch (error) {
        log('[ViewFactory]   ⚠️  释放网络捕获缓冲失败:', error)
      }
    }
  } catch (error) {
    log('[ViewFactory] ⚠️  关闭 Browser/CDP 会话失败:', error)
  }
}

// ---------------------------------------------------------------------------
// cleanupFingerprintPreload
// ---------------------------------------------------------------------------

/**
 * 清理 Session 级 Preload 脚本注册。
 */
export async function cleanupFingerprintPreload(
  sessionPreloadRegistry: SessionPreloadRegistry,
  log: (...args: unknown[]) => void,
): Promise<void> {
  try {
    log('[ViewFactory] 🧹 清理指纹 Preload Script 设置...')
    await cleanupRegisteredSessionPreloads(sessionPreloadRegistry, log)
    log('[ViewFactory] ✅ 指纹 Preload Script 清理完成')
  } catch (error) {
    log('[ViewFactory] ⚠️  清理指纹 Preload 失败:', error)
  }
}

// ---------------------------------------------------------------------------
// startCleanupTimer
// ---------------------------------------------------------------------------

/**
 * 启动空闲清理定时器（每 60 秒一次）。
 */
export function startCleanupTimer(
  runCleanup: () => Promise<void>,
  log: (...args: unknown[]) => void,
): NodeJS.Timeout {
  return setInterval(() => {
    runCleanup().catch(error => {
      log('[ViewFactory] 清理失败:', error)
    })
  }, 60_000)
}

// ---------------------------------------------------------------------------
// forceCleanupForQuota
// ---------------------------------------------------------------------------

/**
 * 配额紧急腾位：跳过活跃门控，使用完全销毁（非 discard）立即释放 views Map 槽位。
 * 仅被 ViewFactory.reserveQuotaOrThrow 在命中兜底配额上限时调用。
 */
export async function forceCleanupForQuota(
  ctx: CleanupContext,
  options?: Pick<CleanupOptions, 'allowedProfiles'>,
): Promise<void> {
  await cleanupIdleViews(ctx, {
    bypassIdleCheck: true,
    forceFullDestroy: true,
    allowedProfiles: options?.allowedProfiles ?? [...QUOTA_RECLAIM_PROFILES],
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTerminalView(entry: ViewEntry): boolean {
  const meta = entry.config.metadata || {}
  return (
    meta.kind === 'terminal' ||
    meta.type === 'terminal' ||
    meta.appId === 'terminal' ||
    entry.config.appId === 'terminal'
  )
}
