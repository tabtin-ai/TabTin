import React, { useCallback, useEffect, useMemo, useRef, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { destroyTerminalSession } from '@components/terminal/terminalRegistry'
import { detachTerminalSession, refreshTerminalViewport, startOrphanSessionGC } from '@components/terminal/terminalRuntime'
import { isSessionClosing } from '@components/terminal/terminalSplitActions'
import { useTerminalPanePortal } from './TerminalPanePortalContext'
import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import { createLogger } from '@/utils/logger'

const log = createLogger('TerminalPortal')
const TerminalSession = React.lazy(() =>
  import('@components/terminal/TerminalSession').then(m => ({ default: m.TerminalSession }))
)

interface TerminalPanePortalLayerProps {
  sessionIds: string[]
}

const buildUniqueSessionIds = (sessionIds: string[]) => {
  const seen = new Set<string>()
  const result: string[] = []
  sessionIds.forEach(id => {
    if (!id || seen.has(id)) return
    seen.add(id)
    result.push(id)
  })
  return result
}

// 延迟清理时间（毫秒）- 防止在布局切换时误删
const DISPOSE_DELAY = 1000
// 延迟移动到 parkingHost（毫秒）- 拖拽 / split-layout 切换的过渡帧内
// root 仍停在原 slot DOM 树中，跟着上层 wrapper 的 display:none 一起不可见，
// 不会闪烁；过渡完成 slot 重新出现时 cancelPendingPark 会取消 timer。
const PARK_DELAY = 120

/**
 * TerminalPanePortalLayer - 终端 Portal 的渲染层
 *
 * 保持终端实例不卸载，仅在 DOM 中移动位置。
 * 使用延迟清理机制防止在拖拽/布局切换时误删终端。
 *
 * ⚠️ 历史踩坑：曾经有一条 "短暂浮层" 分支（applyFloatingStyle + floatingHost），
 *    本意是拖拽过渡时给 root 一个 fixed 定位的可见容器避免闪烁，但因为没有任何
 *    后续机制把它真的回收，与 PersistentTerminalSessions 的 `<Activity hidden>`
 *    （触发 TerminalPanePortalHost 的 effect cleanup → unregisterSlot）凑在一起
 *    就成了 bug：用户切到非 terminal tab 后，root 用 z-modal 浮在原位置盖住
 *    切过去的内容。已删除该分支，统一走 schedulePark。
 */
export const TerminalPanePortalLayer: React.FC<TerminalPanePortalLayerProps> = ({ sessionIds }) => {
  const { slots, slotsVersion, parkingHost, setParkingHost } = useTerminalPanePortal()

  // 合并根 sessionIds 和其分屏子 session IDs。
  //
  // 用 useShallow + 仅扫描 props.sessionIds 涉及的 layouts，避免：
  //   1. 全量订阅 state.layouts 时任何无关 split layout 变化都 rerender 整个 portal layer
  //   2. 输出数组内容未变时仍触发 rerender（shallow equality 兜底）
  //
  // selector 闭包依赖 props.sessionIds：sessionIds 变化时 selector 重跑、shallow 比较新输出；
  // sessionIds 不变但 store 变化时，listener 触发 selector 重跑、shallow 比较抑制不必要的 rerender。
  const allSessionIds = useTerminalSplitStore(
    useShallow(state => {
      const seen = new Set(sessionIds)
      for (const rootId of sessionIds) {
        const layout = state.layouts[rootId]
        if (!layout) continue
        for (const pane of Object.values(layout.panes)) {
          if (pane.sessionId) seen.add(pane.sessionId)
        }
      }
      return Array.from(seen)
    }),
  )

  const uniqueSessionIds = useMemo(() => buildUniqueSessionIds(allSessionIds), [allSessionIds])
  const rootMapRef = useRef<Map<string, HTMLDivElement>>(new Map())
  // 待清理队列：sessionId -> timeoutId
  const pendingDisposeRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // 待移动到 parkingHost 的延迟队列
  const pendingParkRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // 用于追踪上一次的 sessionIds，避免不必要的日志
  const prevSessionIdsRef = useRef<string[]>([])

  const ensureRoot = useCallback((sessionId: string): HTMLDivElement | null => {
    const existing = rootMapRef.current.get(sessionId)
    if (existing) return existing
    if (typeof document === 'undefined') return null
    const root = document.createElement('div')
    root.dataset.terminalPaneRoot = sessionId
    root.style.height = '100%'
    root.style.width = '100%'
    root.style.minHeight = '0'
    root.style.minWidth = '0'
    rootMapRef.current.set(sessionId, root)
    log.debug('创建 root:', sessionId)
    return root
  }, [])

  const resetRootStyle = useCallback((root: HTMLDivElement) => {
    root.style.position = ''
    root.style.left = ''
    root.style.top = ''
    root.style.width = '100%'
    root.style.height = '100%'
    root.style.pointerEvents = ''
    root.style.zIndex = ''
  }, [])

  // 取消待清理
  const cancelPendingDispose = useCallback((sessionId: string) => {
    const timeoutId = pendingDisposeRef.current.get(sessionId)
    if (timeoutId) {
      clearTimeout(timeoutId)
      pendingDisposeRef.current.delete(sessionId)
      log.debug('取消待清理:', sessionId)
    }
  }, [])

  // 取消待停靠
  const cancelPendingPark = useCallback((sessionId: string) => {
    const timeoutId = pendingParkRef.current.get(sessionId)
    if (timeoutId) {
      clearTimeout(timeoutId)
      pendingParkRef.current.delete(sessionId)
      log.debug('取消待停靠:', sessionId)
    }
  }, [])

  // 安排延迟停靠到 parkingHost
  const schedulePark = useCallback((sessionId: string, root: HTMLDivElement) => {
    if (!parkingHost) return
    if (pendingParkRef.current.has(sessionId)) return

    log.debug('安排延迟停靠:', sessionId)
    const timeoutId = setTimeout(() => {
      pendingParkRef.current.delete(sessionId)
      if (slots.get(sessionId)) {
        log.debug('延迟停靠取消（slot 已恢复）:', sessionId)
        return
      }
      if (root.parentElement !== parkingHost) {
        resetRootStyle(root)
        log.debug('延迟停靠执行:', sessionId)
        parkingHost.appendChild(root)
      }
    }, PARK_DELAY)
    pendingParkRef.current.set(sessionId, timeoutId)
  // slots 是 mutable ref，无需加入依赖；setTimeout 回调内读取时是最新值
  }, [parkingHost, resetRootStyle])

  // 安排延迟清理
  const scheduleDispose = useCallback((sessionId: string, root: HTMLDivElement) => {
    // 如果已经在队列中，不重复安排
    if (pendingDisposeRef.current.has(sessionId)) return

    log.debug('安排延迟清理:', sessionId)
    const timeoutId = setTimeout(() => {
      pendingDisposeRef.current.delete(sessionId)
      // 再次检查是否应该清理（可能在延迟期间又变成活跃了）
      const currentActive = new Set(buildUniqueSessionIds(prevSessionIdsRef.current))
      if (currentActive.has(sessionId)) {
        log.debug('延迟清理取消（已重新激活）:', sessionId)
        return
      }
      // B2: 如果 closeSplitPane 正在走 kill→dispose 流程，跳过 Portal 侧 dispose，
      // 让 closeSplitPane 的时序保证优先；DOM root 仍然移除以保持 Portal 状态一致
      if (isSessionClosing(sessionId)) {
        log.debug('延迟清理跳过 dispose（session 正在关闭流程中）:', sessionId)
        root.remove()
        rootMapRef.current.delete(sessionId)
        return
      }
      log.info('执行延迟清理:', sessionId)
      root.remove()
      rootMapRef.current.delete(sessionId)
      destroyTerminalSession(sessionId)
    }, DISPOSE_DELAY)
    pendingDisposeRef.current.set(sessionId, timeoutId)
  }, [])

  useEffect(() => {
    // 记录 sessionIds 变化
    const prevIds = prevSessionIdsRef.current
    const currIds = uniqueSessionIds
    if (prevIds.length !== currIds.length || !prevIds.every((id, i) => id === currIds[i])) {
      log.info('sessionIds 变化:', {
        prev: prevIds,
        curr: currIds,
        added: currIds.filter(id => !prevIds.includes(id)),
        removed: prevIds.filter(id => !currIds.includes(id))
      })
    }
    prevSessionIdsRef.current = currIds

    if (!parkingHost) return

    const rafId = requestAnimationFrame(() => {
      const active = new Set(uniqueSessionIds)

      // 先处理活跃的 sessionIds：取消待清理/停靠，确保 root 存在并正确挂载
      uniqueSessionIds.forEach(sessionId => {
        // 取消待清理
        cancelPendingDispose(sessionId)
        cancelPendingPark(sessionId)

        const root = ensureRoot(sessionId)
        if (!root) return
        const slot = slots.get(sessionId) ?? null
        if (slot) {
          const wasParked = root.parentElement !== slot
          if (wasParked) {
            resetRootStyle(root)
            log.debug('移动 root:', sessionId, 'to slot')
            slot.appendChild(root)
            // 对齐 Table ：迁入可见 slot 后强制一次布局读，再 fit + sync PTY。
            // refreshTerminalViewport 现已在 fit 后调用 syncTerminalPtySize。
            void root.offsetWidth
            requestAnimationFrame(() => refreshTerminalViewport(sessionId))
          }
        } else {
          // slot 不存在（用户切走 tab → Activity hidden → unregisterSlot；
          // 或拖拽 / split-layout 重组的中间帧）。统一走 schedulePark：
          // 120ms 内若 slot 重新出现就 cancel 掉（拖拽完成），否则把 root
          // 移到屏幕外的 parkingHost。这 120ms 内 root 仍在原 slot DOM 树
          // 中，跟着上层 wrapper 的 display:none 一起不可见，不会闪烁。
          schedulePark(sessionId, root)
        }
      })

      // 处理不再活跃的 sessionIds：安排延迟清理
      rootMapRef.current.forEach((root, sessionId) => {
        if (!active.has(sessionId)) {
          scheduleDispose(sessionId, root)
        }
      })
    })

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [
    ensureRoot,
    uniqueSessionIds,
    slots,
    slotsVersion,
    parkingHost,
    cancelPendingDispose,
    cancelPendingPark,
    resetRootStyle,
    scheduleDispose,
    schedulePark
  ])

  // 孤儿 session GC：定期扫描 terminalCache 中不在 allSessionIds 中且超过宽限期的条目
  const allSessionIdsRef = useRef(new Set(allSessionIds))
  allSessionIdsRef.current = new Set(allSessionIds)
  useEffect(() => {
    return startOrphanSessionGC(() => allSessionIdsRef.current)
  }, [])

  // 组件卸载时清理计时器和 DOM root。
  // Terminal 实例和 PTY 订阅保持活跃，由 orphan GC（30s 宽限期）负责最终清理。
  useEffect(() => {
    return () => {
      pendingDisposeRef.current.forEach((timeoutId) => {
        clearTimeout(timeoutId)
      })
      pendingDisposeRef.current.clear()
      pendingParkRef.current.forEach((timeoutId) => {
        clearTimeout(timeoutId)
      })
      pendingParkRef.current.clear()

      rootMapRef.current.forEach((root, sessionId) => {
        log.info('Portal 卸载，detach 终端:', sessionId)
        detachTerminalSession(sessionId)
        root.remove()
      })
      rootMapRef.current.clear()
    }
  }, [])

  return (
    <>
      <div
        ref={setParkingHost}
        className="pointer-events-none fixed"
        style={{
          left: '-10000px',
          top: '-10000px',
          width: '800px',
          height: '600px',
          overflow: 'hidden'
        }}
        aria-hidden="true"
        data-terminal-pane-parking="true"
      />
      {uniqueSessionIds.map(sessionId => {
        const root = ensureRoot(sessionId)
        if (!root) return null
        return createPortal(
          <Suspense fallback={<div className="h-full w-full" />}>
            <TerminalSession
              sessionId={sessionId}
              className="h-full w-full"
              data-terminal-session-id={sessionId}
            />
          </Suspense>,
          root,
          sessionId
        )
      })}
    </>
  )
}

TerminalPanePortalLayer.displayName = 'TerminalPanePortalLayer'

