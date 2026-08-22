/**
 * TerminalSplitContainer - 终端标签内的分屏容器
 *
 * 当终端有多个分屏 pane 时渲染分屏布局（LayoutGroup / LayoutPanel / LayoutSeparator），
 * 只有一个 pane 时直接渲染终端。
 *
 * 复用 split-layout.ts 的共享布局树工具和 resizable-v4 的布局原语。
 */

import React, { Activity, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import { useTranslation } from 'react-i18next'
import {
  LayoutGroup,
  LayoutPanel,
  LayoutSeparator,
} from '@components/layout/resizable-v4'
import { TerminalPanePortalHost } from '@components/terminal/portal/TerminalPanePortalHost'
import { TerminalPaneHeader } from './TerminalPaneHeader'
import { TerminalContextMenu } from './TerminalContextMenu'
import { TerminalSearch } from './TerminalSearch'
import { ScrollToBottomButton } from './ScrollToBottomButton'
import { useTerminalSplitStore } from '@stores/useTerminalSplitStore'
import {
  type LayoutNode,
  collectLeafIds,
  normalizeSizes,
} from '@/utils/split-layout'
import {
  useTerminalSessionStore,
  killPtySession,
} from '@components/context-space/sources/terminal'
import { useTerminalPaneStatusStore } from '@stores/useTerminalPaneStatusStore'
import { createSplitPane, closeSplitPane } from './terminalSplitActions'
import { destroyTerminalSession } from './terminalRegistry'

// ────────────────────────────────────────────────────────────
// Props
// ────────────────────────────────────────────────────────────

interface TerminalSplitContainerProps {
  rootSessionId: string
  spaceId?: string
  onPaneInteraction?: () => void
}

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const getPathKey = (path: number[]): string =>
  path.length > 0 ? path.join('.') : 'root'

const getPanelId = (
  rootSessionId: string,
  path: number[],
  child: LayoutNode,
  index: number,
): string => {
  const childKey = child.type === 'leaf' ? child.paneId : child.id
  const pathKey = path.length > 0 ? path.join('-') : 'root'
  return `term-split-${rootSessionId}-${pathKey}-${index}-${childKey}`.replace(
    /[^a-zA-Z0-9_-]/g,
    '-',
  )
}

const resolveLayoutSizes = (
  layoutData: unknown,
  panelIds: string[],
): number[] | null => {
  if (
    !layoutData ||
    typeof layoutData !== 'object' ||
    Array.isArray(layoutData)
  ) {
    return null
  }
  const layoutMap = layoutData as Record<string, number>
  const ratioSizes = panelIds.map(panelId => {
    const percent = layoutMap[panelId]
    if (typeof percent !== 'number') return 0
    return percent / 100
  })
  return normalizeSizes(ratioSizes, panelIds.length)
}

// ────────────────────────────────────────────────────────────
// Component
// ────────────────────────────────────────────────────────────

export const TerminalSplitContainer: React.FC<TerminalSplitContainerProps> = ({
  rootSessionId,
  spaceId: spaceIdProp,
  onPaneInteraction,
}) => {
  // 从 split layout 或 session store 推导 spaceId
  const layoutSpaceId = useTerminalSplitStore(
    state => state.layouts[rootSessionId]?.spaceId ?? '',
  )
  const resolvedSpaceId = useTerminalSessionStore(state => {
    // 优先使用 prop 或已缓存的 layout spaceId，避免全量遍历
    if (spaceIdProp) return spaceIdProp
    if (layoutSpaceId) return layoutSpaceId
    for (const [sid, sessions] of Object.entries(state.sessionsBySpace)) {
      if (sessions.some(s => s.id === rootSessionId)) return sid
    }
    return ''
  })

  const layout = useTerminalSplitStore(
    state => state.layouts[rootSessionId] ?? null,
  )
  const setActivePane = useTerminalSplitStore(state => state.setActivePane)
  const setSplitSizes = useTerminalSplitStore(state => state.setSplitSizes)
  const equalizeSizes = useTerminalSplitStore(state => state.equalizeSizes)

  const liveLayoutByPathRef = useRef<Record<string, number[]>>({})

  // 确保 layout 已初始化
  React.useEffect(() => {
    if (!resolvedSpaceId) return
    useTerminalSplitStore.getState().ensureLayout(rootSessionId, resolvedSpaceId)
  }, [rootSessionId, resolvedSpaceId])

  const paneCount = useMemo(() => {
    if (!layout) return 1
    return Object.keys(layout.panes).length
  }, [layout])

  const isMaximized = layout?.maximizedPaneId != null
  const maximizedPaneId = layout?.maximizedPaneId ?? null

  // ── 搜索状态 ──
  const [searchSessionId, setSearchSessionId] = useState<string | null>(null)
  const closeSearch = useCallback(() => setSearchSessionId(null), [])

  // ── 重启 pane 状态（ER-12：多 pane 模式下原地重启已退出 session） ──
  const [restartKeys, setRestartKeys] = useState<Record<string, number>>({})

  const handleRestartPane = useCallback((sessionId: string) => {
    // 先销毁旧的终端缓存和 PTY，然后通过 key bump 触发 XTerminal 重建
    void killPtySession(sessionId).then(() => {
      destroyTerminalSession(sessionId)
    }).finally(() => {
      // 清除 pane 退出状态
      useTerminalPaneStatusStore.getState().removeStatus(sessionId)
      // key bump 触发 TerminalSession 内部 XTerminal 重新创建
      setRestartKeys(prev => ({ ...prev, [sessionId]: (prev[sessionId] ?? 0) + 1 }))
    })
  }, [])

  // ── 分隔条尺寸持久化 ──

  const handleLayoutChanged = useCallback(
    (layoutData: unknown, path: number[], panelIds: string[]) => {
      const nextSizes = resolveLayoutSizes(layoutData, panelIds)
      if (!nextSizes) return
      const pathKey = getPathKey(path)
      liveLayoutByPathRef.current[pathKey] = nextSizes
      setSplitSizes(rootSessionId, path, nextSizes)
    },
    [rootSessionId, setSplitSizes],
  )

  // ── Focus pane ──

  const focusPane = useCallback(
    (paneId: string) => {
      setActivePane(rootSessionId, paneId)
    },
    [rootSessionId, setActivePane],
  )

  const { t } = useTranslation('terminal')

  // ── 键盘快捷键 ──
  // Cmd+D: 水平分屏  Cmd+Shift+D: 垂直分屏
  // Cmd+Option+←/→: 切换焦点 pane  Cmd+Shift+W: 关闭当前 pane

  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const IS_MAC = navigator.platform.startsWith('Mac')
    const handler = (e: KeyboardEvent) => {
      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      if (!mod) return

      // Cmd+F: 终端内搜索（不依赖 layout 状态，单 pane 也可用）
      if (e.key === 'f' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        const currentLayout = useTerminalSplitStore.getState().layouts[rootSessionId]
        const activePane = currentLayout?.panes[currentLayout.activePaneId]
        setSearchSessionId(activePane?.sessionId ?? rootSessionId)
        return
      }

      const currentLayout = useTerminalSplitStore.getState().layouts[rootSessionId]
      if (!currentLayout) return
      const panes = currentLayout.panes
      const panesCount = Object.keys(panes).length

      // Cmd+D: 水平分屏
      if (e.key === 'd' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        if (panesCount >= 6) return
        const activePaneId = currentLayout.activePaneId
        const activePane = panes[activePaneId]
        createSplitPane({
          rootSessionId,
          targetPaneId: activePaneId,
          direction: 'horizontal',
          side: 'right',
          spaceId: resolvedSpaceId,
          defaultTitle: t('title'),
          inheritFromSessionId: activePane?.sessionId,
        })
        return
      }

      // Cmd+Shift+D: 垂直分屏
      if (e.key === 'D' && e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        if (panesCount >= 6) return
        const activePaneId = currentLayout.activePaneId
        const activePane = panes[activePaneId]
        createSplitPane({
          rootSessionId,
          targetPaneId: activePaneId,
          direction: 'vertical',
          side: 'bottom',
          spaceId: resolvedSpaceId,
          defaultTitle: t('title'),
          inheritFromSessionId: activePane?.sessionId,
        })
        return
      }

      // Cmd+Shift+W: 关闭当前 pane（仅多 pane 时）
      if (e.key === 'W' && e.shiftKey && !e.altKey && panesCount > 1) {
        e.preventDefault()
        e.stopPropagation()
        const activePaneId = currentLayout.activePaneId
        const activePane = panes[activePaneId]
        if (!activePane) return
        closeSplitPane({
          rootSessionId,
          paneId: activePaneId,
          sessionId: activePane.sessionId,
          spaceId: resolvedSpaceId,
        })
        return
      }

      // Cmd+Option+← / Cmd+Option+→: 切换焦点 pane
      if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        const leafIds = collectLeafIds(currentLayout.layout)
        if (leafIds.length <= 1) return
        const currentIndex = leafIds.indexOf(currentLayout.activePaneId)
        const delta = e.key === 'ArrowRight' ? 1 : -1
        const nextIndex = (currentIndex + delta + leafIds.length) % leafIds.length
        useTerminalSplitStore.getState().setActivePane(rootSessionId, leafIds[nextIndex])
        return
      }
    }

    el.addEventListener('keydown', handler, true)
    return () => el.removeEventListener('keydown', handler, true)
  }, [rootSessionId, resolvedSpaceId, t])

  // ── 无 layout 或单 pane：直接渲染终端 ──

  if (!layout || paneCount <= 1) {
    return (
      <div ref={containerRef} className="h-full w-full relative">
        <TerminalContextMenu
          sessionId={rootSessionId}
          rootSessionId={rootSessionId}
          spaceId={resolvedSpaceId}
          paneCount={1}
          isMaximized={false}
          onSearch={() => setSearchSessionId(rootSessionId)}
        >
          <TerminalPanePortalHost
            sessionId={rootSessionId}
            className="h-full w-full"
            onInteraction={onPaneInteraction}
          />
        </TerminalContextMenu>
        {searchSessionId === rootSessionId && (
          <TerminalSearch sessionId={rootSessionId} onClose={closeSearch} />
        )}
        <ScrollToBottomButton sessionId={rootSessionId} />
      </div>
    )
  }

  // ── 多 pane 渲染 ──

  const renderPane = (paneId: string, hidden = false) => {
    const pane = layout.panes[paneId]
    if (!pane) return null

    const isActive = layout.activePaneId === paneId
    const isPaneMaximized = maximizedPaneId === paneId

    return (
      <div
        className={cn(
          'h-full w-full flex flex-col',
          isActive && 'ring-1 ring-accent/40 rounded-sm',
          hidden && 'hidden',
        )}
        onPointerDownCapture={e => {
          if (e.button !== 0) return
          focusPane(paneId)
          onPaneInteraction?.()
        }}
      >
        {/* Header - 仅多 pane 时显示 */}
        <TerminalPaneHeader
          pane={pane}
          isActive={isActive}
          isMaximized={isPaneMaximized}
          rootSessionId={rootSessionId}
          onRestartPane={handleRestartPane}
        />
        {/* Terminal - restartKeys 用于多 pane 原地重启 (ER-12) */}
        <div className="flex-1 min-h-0 relative" key={restartKeys[pane.sessionId] ?? 0}>
          <TerminalContextMenu
            sessionId={pane.sessionId}
            paneId={paneId}
            rootSessionId={rootSessionId}
            spaceId={resolvedSpaceId}
            paneCount={paneCount}
            isMaximized={isMaximized}
            onSearch={() => setSearchSessionId(pane.sessionId)}
          >
            <TerminalPanePortalHost
              sessionId={pane.sessionId}
              className="h-full w-full"
            />
          </TerminalContextMenu>
          {searchSessionId === pane.sessionId && (
            <TerminalSearch
              sessionId={pane.sessionId}
              onClose={closeSearch}
            />
          )}
          <ScrollToBottomButton sessionId={pane.sessionId} />
        </div>
      </div>
    )
  }

  // ── 最大化模式：只显示一个 pane，其余用 `<Activity hidden>` 暂停 ──
  // Activity hidden 让非最大化 pane 的 xterm / 测量 effect 自动 cleanup，
  // 节省 CPU。pty 输出仍在 store buffer，unmaximize 后 xterm 重建并应用
  // 完整 buffer 即可看到最新内容。

  if (isMaximized && maximizedPaneId) {
    const allPaneIds = Object.keys(layout.panes)
    return (
      <div ref={containerRef} className="h-full w-full relative">
        {allPaneIds.map(id => {
          const isMax = id === maximizedPaneId
          return (
            <Activity key={id} mode={isMax ? 'visible' : 'hidden'}>
              <div className="absolute inset-0">
                {renderPane(id, !isMax)}
              </div>
            </Activity>
          )
        })}
      </div>
    )
  }

  // ── 递归渲染布局树 ──

  const renderNode = (
    node: LayoutNode,
    path: number[],
    isRoot = false,
  ): React.ReactNode => {
    if (node.type === 'leaf') {
      return renderPane(node.paneId)
    }

    const isHorizontal = node.direction === 'horizontal'
    const pathKey = getPathKey(path)
    const sizes = normalizeSizes(node.sizes, node.children.length)
    const panelIds = node.children.map((child, index) =>
      getPanelId(rootSessionId, path, child, index),
    )
    const orientation = isHorizontal ? 'horizontal' : 'vertical'
    const minRatio = 0.15

    return (
      <LayoutGroup
        id={`term-split-group-${rootSessionId}-${pathKey}`}
        orientation={orientation}
        className={cn(
          'h-full w-full',
          isHorizontal ? 'flex-row' : 'flex-col',
          isRoot && 'relative',
        )}
        onLayoutChange={(layoutData: unknown) => {
          const nextSizes = resolveLayoutSizes(layoutData, panelIds)
          if (!nextSizes) return
          liveLayoutByPathRef.current[pathKey] = nextSizes
        }}
        onLayoutChanged={(layoutData: unknown) => {
          handleLayoutChanged(layoutData, path, panelIds)
        }}
      >
        {node.children.map((child, index) => {
          const stableKey =
            child.type === 'leaf' ? child.paneId : child.id
          return (
            <React.Fragment key={stableKey}>
              <LayoutPanel
                id={panelIds[index]}
                defaultSize={`${(sizes[index] ?? 0) * 100}%`}
                minSize={`${minRatio * 100}%`}
                className="min-w-0 min-h-0 overflow-hidden"
              >
                {renderNode(child, [...path, index])}
              </LayoutPanel>

              {index < node.children.length - 1 && (
                <LayoutSeparator
                  className={cn(
                    'group/handle',
                    isHorizontal
                      ? '!w-px cursor-col-resize bg-border/30 hover:bg-border/60'
                      : '!h-px cursor-row-resize bg-border/30 hover:bg-border/60',
                  )}
                  title={t('split.doubleClickToEqualize')}
                  onDoubleClick={() => equalizeSizes(rootSessionId, path)}
                />
              )}
            </React.Fragment>
          )
        })}
      </LayoutGroup>
    )
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      {renderNode(layout.layout, [], true)}
    </div>
  )
}

TerminalSplitContainer.displayName = 'TerminalSplitContainer'
