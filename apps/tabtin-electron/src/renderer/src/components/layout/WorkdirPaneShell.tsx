/**
 * WorkdirPaneShell — Agent 工作目录面板的共享外壳
 *
 * TabCode（代码视角）与 TabFolder（文件视角）布局同构：顶部控制区 +
 * 「可调左侧栏 + 右侧内容」。此前两者各写一遍外壳，且 TabCode 的侧栏
 * resize 是坏的（只发埋点、宽度从不更新）。这里把外壳收敛为一处：
 *
 * - 结构性边线：header 底部分隔 + 侧栏/预览区竖线（无外层套框，避免双边框）
 * - header slot：各面板传入自己的 toolbar / header
 * - 可调左侧栏：像素宽 flex 侧栏（只响应自身手柄，不随父级应用区 resize 重分配）
 * - content slot：预览 / diff / 搜索结果（Monaco 等内容画布仍无边框）
 * - overlay slot：主区内绝对定位的侧面板（如版本历史）
 * - 侧栏折叠：与 contentVisible 正交；折叠后 content 占满
 *
 * 文件树与预览的差异仍由各面板以 slot 注入——本外壳只统一骨架。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '@utils/cn'
import {
  startLayoutResizeTelemetry,
  trackLayoutTelemetry,
  type LayoutV4Scope,
} from '@utils/layout/telemetry'

export interface WorkdirPaneShellProps {
  /** 布局节点与 DOM id 用的稳定 id，需在面板实例间唯一。 */
  layoutId: string
  /** 埋点 surface（'tabcode' | 'file-explorer' 等）。 */
  surface: LayoutV4Scope
  /**
   * 顶部控制区（toolbar / header）。传入时渲染在顶部分隔带；
   * TabCode 布局改造后可省略，把控件沉到整面板底栏。
   */
  header?: React.ReactNode
  /** 左侧栏内容（文件树，或替换文件树的搜索面板）。 */
  sidebar: React.ReactNode
  /** 右侧内容区（预览 / diff / 搜索结果）。 */
  children: React.ReactNode
  /**
   * 整面板通栏底栏（跨侧栏 + 内容区）。
   * TabCode 用它放收起/展开、分支、Worktree 等状态控件。
   */
  footer?: React.ReactNode
  /** 主区内绝对定位的浮层（如版本历史侧面板）。 */
  overlay?: React.ReactNode
  /** 是否展示右侧内容区；关闭时左侧栏占满剩余空间。 */
  contentVisible?: boolean
  /** 用于文件浏览器：切换右侧内容时保持左侧树组件不重挂。 */
  preserveSidebarOnContentToggle?: boolean
  /**
   * 是否折叠左侧栏。与 contentVisible 正交：折叠后 content 占满；
   * 若同时 contentVisible=false，仍以 content 区域为准（不把侧栏拉满）。
   */
  sidebarCollapsed?: boolean
  sidebarMinWidth?: number
  sidebarMaxWidth?: number
  sidebarDefaultWidth?: number
  className?: string
}

const DEFAULT_MIN_WIDTH = 180
const DEFAULT_MAX_WIDTH = 500
const DEFAULT_WIDTH = 260
const DRIVER = 'workdir-flex-sidebar'

/** 把侧栏右边缘钉到设备像素，避免 125%/150% 缩放下 1px 分界线时粗时细。 */
function snapSidebarWidthToDevicePixel(
  width: number,
  minWidth: number,
  maxWidth: number,
  sidebarLeftCssPx = 0,
): number {
  const clamped = Math.max(minWidth, Math.min(maxWidth, width))
  if (typeof window === 'undefined') return clamped
  const dpr = window.devicePixelRatio || 1
  const right = sidebarLeftCssPx + clamped
  const snappedRight = Math.round(right * dpr) / dpr
  return Math.max(minWidth, Math.min(maxWidth, snappedRight - sidebarLeftCssPx))
}

export const WorkdirPaneShell: React.FC<WorkdirPaneShellProps> = ({
  layoutId,
  surface,
  header,
  sidebar,
  children,
  footer,
  overlay,
  contentVisible = true,
  preserveSidebarOnContentToggle = false,
  sidebarCollapsed = false,
  sidebarMinWidth = DEFAULT_MIN_WIDTH,
  sidebarMaxWidth = DEFAULT_MAX_WIDTH,
  sidebarDefaultWidth = DEFAULT_WIDTH,
  className,
}) => {
  const [sidebarWidth, setSidebarWidth] = useState(sidebarDefaultWidth)
  const resizeSessionRef = useRef<ReturnType<typeof startLayoutResizeTelemetry> | null>(null)
  const manualResizeWidthRef = useRef(sidebarDefaultWidth)

  useEffect(() => {
    trackLayoutTelemetry(
      'feature_flag_checked',
      surface,
      { module: 'WorkdirPaneShell', enabled: true, mode: 'enforced_v4' },
      { counterKey: `${surface}.feature_flag_checked.enabled` },
    )
  }, [surface])

  useEffect(() => {
    return () => {
      if (!resizeSessionRef.current) return
      resizeSessionRef.current.cancel({ reason: 'component_unmount' })
      resizeSessionRef.current = null
    }
  }, [])

  const handleManualResizeStart = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    if (resizeSessionRef.current) {
      resizeSessionRef.current.cancel({ reason: 'restart' })
    }
    resizeSessionRef.current = startLayoutResizeTelemetry(surface, {
      panel: 'file-tree',
      startWidth: sidebarWidth,
      minWidth: sidebarMinWidth,
      maxWidth: sidebarMaxWidth,
      driver: DRIVER,
    })

    const startX = event.clientX
    const startWidth = sidebarWidth
    const sidebarLeft = event.currentTarget.parentElement?.getBoundingClientRect().left ?? 0
    manualResizeWidthRef.current = sidebarWidth

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const nextWidth = snapSidebarWidthToDevicePixel(
        startWidth + moveEvent.clientX - startX,
        sidebarMinWidth,
        sidebarMaxWidth,
        sidebarLeft,
      )
      manualResizeWidthRef.current = nextWidth
      setSidebarWidth(prev => (Math.abs(prev - nextWidth) < 0.5 ? prev : nextWidth))
    }

    const finishManualResize = () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', finishManualResize, true)
      window.removeEventListener('blur', finishManualResize)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''

      if (!resizeSessionRef.current) return
      const finalWidth = Math.round(manualResizeWidthRef.current)
      resizeSessionRef.current.end({ finalWidth, driver: DRIVER })
      resizeSessionRef.current.persistSuccess({ finalWidth, driver: DRIVER })
      resizeSessionRef.current = null
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', finishManualResize, true)
    window.addEventListener('blur', finishManualResize)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [surface, sidebarWidth, sidebarMinWidth, sidebarMaxWidth])

  const sidebarStyle = preserveSidebarOnContentToggle && !contentVisible && !sidebarCollapsed
    ? {
        width: '100%',
        minWidth: 0,
        maxWidth: 'none',
      }
    : {
        width: sidebarWidth,
        minWidth: sidebarMinWidth,
        maxWidth: sidebarMaxWidth,
      }

  // 侧栏折叠时以 content 为准，即使 contentVisible=false 也不把侧栏拉满。
  const showContent = contentVisible || sidebarCollapsed

  return (
    <div className={cn('flex h-full w-full flex-col bg-background', className)}>
      {header != null && (
        <div className="shrink-0 border-b border-border/30">{header}</div>
      )}

      <div
        id={`workdir-pane-${layoutId}`}
        className="relative flex flex-1 min-h-0 min-w-0"
      >
        {!sidebarCollapsed && (
          <div
            id={`workdir-pane-tree-${layoutId}`}
            className="relative flex h-full min-h-0 shrink-0 flex-col overflow-hidden bg-muted/20"
            style={sidebarStyle}
            data-testid="workdir-pane-sidebar"
          >
            {sidebar}
            {showContent && (
              <div
                // 面板内分割手柄只需压过侧栏内容；z-dropdown(55) 高于 z-modal(50)，
                // 会把竖线叠到确认弹窗之上。
                className="absolute right-0 top-0 bottom-0 z-sticky w-2 cursor-col-resize group/resize"
                onMouseDown={handleManualResizeStart}
                role="separator"
                aria-orientation="vertical"
              >
                {/* 线宽/透明度保持恒定，避免拖完后看起来变粗；不额外加 hover 底色以免像阴影。 */}
                <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-px bg-border/60" />
              </div>
            )}
          </div>
        )}

        <div
          id={`workdir-pane-content-${layoutId}`}
          className={cn('min-w-0 flex-1 bg-background', !showContent && 'hidden')}
          data-testid="workdir-pane-content"
        >
          {children}
        </div>

        {showContent ? overlay : null}
      </div>

      {footer != null && (
        <div
          className="shrink-0 border-t border-border/40 bg-background"
          data-testid="workdir-pane-footer"
        >
          {footer}
        </div>
      )}
    </div>
  )
}

WorkdirPaneShell.displayName = 'WorkdirPaneShell'
