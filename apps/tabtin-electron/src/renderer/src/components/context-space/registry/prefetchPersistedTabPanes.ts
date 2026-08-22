/**
 * 启动恢复会话时，提前预热「已持久化的活动 Tab」对应的 renderPane lazy chunk。
 *
 * 背景：每个 ContextTypeHandler 的 renderPane 是独立 lazy chunk，被恢复的活动
 * Tab 在挂载那一刻才开始下载/编译，导致内容区闪一次 Suspense fallback（"跳
 * loading"）。这里在首帧之后的 idle 窗口里，按持久化的活动 Tab type 提前触发
 * 对应 handler.prefetch（与 renderPane 内 React.lazy 共用同一个 import），让恢复
 * 的 Tab 挂载时 chunk 已就绪。
 *
 * 设计取向：
 * - 只预热「各 Space 的活动 Tab type」（去重），不预热全部打开 Tab——聚焦启动，
 *   避免无脑预热低频重 pane 抢占资源。
 * - 即时并行触发：由 main.tsx 在 bootstrap 期间（AppLayout 外壳 preload 完成后）调用，
 *   chunk 下载/编译与 deviceId 同步 / runtimeInit / 首次渲染重叠，让恢复的活动 Tab
 *   挂载时 chunk 更可能已就绪。仅 kick off async import，不做同步重活，不阻塞 bootstrap。
 * - 幂等：仅执行一次；detached 辅助窗口直接跳过。
 */
import { contextRegistry } from './instance'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { parseTabKey } from '@/stores/contextTabs/helpers'
import { isDetachedIMWindow } from '@/utils/detachedIM'
import { logger } from '@/utils/logger'

let _started = false
let _chatRailStarted = false

/** 收集所有 Space 的活动 Tab type（去重，保持首次出现顺序）。 */
function collectActiveTabTypes(): string[] {
  const { activeKeyBySpace } = useSpaceContextTabsStore.getState()
  const seen = new Set<string>()
  const types: string[] = []
  for (const key of Object.values(activeKeyBySpace)) {
    if (!key) continue
    const type = parseTabKey(key)?.type
    if (!type || seen.has(type)) continue
    seen.add(type)
    types.push(type)
  }
  return types
}

export function prefetchPersistedTabPanes(): void {
  if (_started) return
  if (typeof window === 'undefined') return
  if (isDetachedIMWindow()) return
  _started = true

  const types = collectActiveTabTypes()
  if (types.length === 0) return
  const prefetched: string[] = []
  for (const type of types) {
    const prefetch = contextRegistry.getHandler(type)?.prefetch
    if (!prefetch) continue
    prefetched.push(type)
    // 即时 kick off，多个 type 的 chunk 并行下载；best-effort——失败只降级为
    // 「打开时仍走 Suspense」，不影响任何功能。
    prefetch().catch((err) => logger.debug('[prefetchTabPanes] chunk 预热失败', { type, err }))
  }
  if (prefetched.length > 0) {
    logger.debug('[prefetchTabPanes] 并行预热活动 Tab chunk', { types: prefetched })
  }
}

/**
 * 预热聊天栏 chunk（SpaceChatRailHost → ChatSidePanel → ChatPanel）。
 *
 * 「外壳挂载后右侧聊天栏闪 ShellChatPanelSkeleton」这一阶段，部分卡在 SpaceChatRailHost
 * 这个 lazy chunk 下载。这里在 bootstrap 期间并行 kick off，让聊天栏更快变实。
 * 经 ShellSidePanelContent 暴露的 preloadChatRail 走同一个 loader；动态 import 避免把
 * 聊天栏依赖拉进 main 入口图。detached 辅助窗口不挂主外壳，直接跳过（也避免误拉 AppLayout chunk）。
 */
export function prefetchChatRail(): void {
  if (_chatRailStarted) return
  if (typeof window === 'undefined') return
  if (isDetachedIMWindow()) return
  _chatRailStarted = true

  void import('@components/layout/ShellSidePanelContent')
    .then((m) => m.preloadChatRail())
    .catch((err) => logger.debug('[prefetchChatRail] 聊天栏 chunk 预热失败', { err }))
}
