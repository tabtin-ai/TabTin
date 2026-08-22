/**
 * Sidebar 侧边栏组件（纯 UI 层）
 *
 * 职责：
 * - 提供侧边栏容器布局（头部/内容/底部）
 * - 支持拖拽调整宽度
 * - 支持展开/折叠
 * - 不包含业务逻辑和状态管理
 *
 * 视觉规范：
 * - 默认宽度：280–420px（推荐 320px）
 * - 折叠宽度：64px
 * - 拖拽热区：12px（视觉 2px）
 * - 过渡时长：150–200ms
 */

import React, { useRef, useCallback, useEffect } from 'react'
import { t } from "../../i18n"

export interface SidebarProps {
  /** 侧边栏宽度（展开时） */
  width: number
  /** 是否折叠 */
  collapsed: boolean
  /** 宽度变化回调 */
  onResize: (width: number) => void
  /** 折叠/展开切换回调 */
  onToggle: () => void
  /** 头部内容 */
  header?: React.ReactNode
  /** 底部内容 */
  footer?: React.ReactNode
  /** 主内容 */
  children?: React.ReactNode
  /** 最小宽度 */
  minWidth?: number
  /** 最大宽度 */
  maxWidth?: number
  /** 是否启用内置拖拽 */
  resizable?: boolean
  /** 使用容器宽度（外部控制） */
  useContainerWidth?: boolean
}

export const Sidebar: React.FC<SidebarProps> = ({
  width,
  collapsed,
  onResize,
  onToggle,
  header,
  footer,
  children,
  minWidth = 250,
  maxWidth = 500,
  resizable = true,
  useContainerWidth = false,
}) => {
  const isResizing = useRef(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const rafRef = useRef<number | null>(null)
  const pendingWidthRef = useRef<number | null>(null)

  const scheduleLiveResize = useCallback((nextWidth: number) => {
    pendingWidthRef.current = nextWidth
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      if (pendingWidthRef.current === null || !rootRef.current) return
      rootRef.current.style.width = `${pendingWidthRef.current}px`
    })
  }, [])

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [])

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed) return

    e.preventDefault()
    isResizing.current = true
    const startX = e.clientX
    const startWidth = width
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    if (rootRef.current) {
      rootRef.current.style.setProperty('transition', 'none')
      rootRef.current.style.setProperty('will-change', 'width')
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!isResizing.current) return
      const deltaX = event.clientX - startX
      const newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX))
      scheduleLiveResize(newWidth)
    }

    const handlePointerUp = () => {
      isResizing.current = false
      handle.removeEventListener('pointermove', handlePointerMove)
      handle.removeEventListener('pointerup', handlePointerUp)
      handle.removeEventListener('pointercancel', handlePointerUp)
      handle.releasePointerCapture(e.pointerId)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      const finalWidth = pendingWidthRef.current ?? startWidth
      pendingWidthRef.current = null
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
      if (rootRef.current) {
        rootRef.current.style.width = `${finalWidth}px`
      }
      onResize(finalWidth)
      if (rootRef.current) {
        rootRef.current.style.removeProperty('transition')
        rootRef.current.style.removeProperty('will-change')
      }
    }

    handle.addEventListener('pointermove', handlePointerMove)
    handle.addEventListener('pointerup', handlePointerUp)
    handle.addEventListener('pointercancel', handlePointerUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [collapsed, width, minWidth, maxWidth, onResize, scheduleLiveResize])

  const collapsedWidth = 64
  const resolvedMinWidth = collapsed ? collapsedWidth : minWidth
  const resolvedMaxWidth = collapsed ? collapsedWidth : maxWidth
  const resolvedWidth = collapsed ? collapsedWidth : width
  const resolvedStyle = useContainerWidth
    ? { width: '100%' }
    : {
        width: resolvedWidth,
        minWidth: resolvedMinWidth,
        maxWidth: resolvedMaxWidth,
      }

  return (
    <div
      className="relative h-full flex flex-col flex-shrink-0 transition-[width] duration-200 ease-out"
      ref={rootRef}
      style={resolvedStyle}
    >
      {/* Header */}
      {header && (
        <div className="px-3 flex-shrink-0">
          {header}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {children}
      </div>

      {/* Footer */}
      {footer && (
        <div className="flex-shrink-0">
          {footer}
        </div>
      )}

      {/* Resize handle - 12px 命中区，2px 视觉 */}
      {!collapsed && resizable && (
        <div
          className="absolute top-0 right-0 h-full cursor-col-resize group/resize"
          style={{ width: 12, touchAction: 'none' }}
          onPointerDown={handlePointerDown}
          title={t('sidebar.resize')}
        >
          <div className="ml-auto h-full w-[2px] bg-transparent group-hover/resize:bg-accent/40 group-active/resize:bg-accent/60 transition-colors duration-150" />
        </div>
      )}
    </div>
  )
}
