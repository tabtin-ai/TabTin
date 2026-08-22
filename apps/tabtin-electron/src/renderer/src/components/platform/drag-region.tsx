import React from 'react'
import { cn } from '@/utils/cn'

/**
 * 窗口顶部拖拽条高度。
 *
 * 布局契约：主窗口的实体标题栏行是 AppLayout 的 `ShellTopBar`（左侧 drag 区 +
 * 右侧独立 no-drag 窗口控件槽），内容区不再需要透明 overlay 让位。
 * 本文件的 overlay 拖拽带仅用于**没有 ShellTopBar** 的窗口（如私信独立窗经
 * `ShellTitleBar fallbackDrag` 开启）。主窗禁止整行 drag 含右侧控件留白，也
 * 禁止再盖一层可命中全宽 drag。overlay 仍用 `reserve*` 避开控件。
 */
export const WINDOW_DRAG_REGION_HEIGHT = 36
export const WINDOW_DRAG_REGION_MAC_TRAFFIC_LIGHT_WIDTH = 92
/** min/max h-8(32×2) + close w-12(48) + 2×gap-1(8) + 左右 pl/pr-1(8) */
export const WINDOW_DRAG_REGION_WINDOWS_CONTROL_WIDTH = 128

type AppRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag'
}

interface DragRegionProps {
  className?: string
  children?: React.ReactNode
  height?: number
  style?: React.CSSProperties
}

export function DragRegion({ className, children, height = 30, style }: DragRegionProps) {
  const appRegionStyle: AppRegionStyle = {
    height: `${height}px`,
    WebkitAppRegion: children ? 'no-drag' : 'drag',
    ...style
  }
  const noDragStyle: AppRegionStyle = {
    WebkitAppRegion: 'no-drag',
  }

  return (
    <div
      className={cn(
        'select-none bg-transparent',
        children ? 'app-region-no-drag' : 'app-region-drag',
        className
      )}
      style={appRegionStyle}
    >
      {children && (
        <div
          style={noDragStyle}
          className="app-region-no-drag h-full"
        >
          {children}
        </div>
      )}
    </div>
  )
}

interface WindowDragRegionProps {
  className?: string
  height?: number
  /** 左侧不进入拖拽的宽度（红绿灯、侧栏开关等互斥 slot） */
  reserveLeft?: number
  /** 右侧不进入拖拽的宽度（Windows 窗口控件等） */
  reserveRight?: number
}

/**
 * 全窗顶部透明拖拽条（absolute overlay）。
 * 仅负责「可拖」几何；可点控件必须落在条带外或 `reserveLeft` / `reserveRight` 空隙内。
 */
export function WindowDragRegion({
  className,
  height = WINDOW_DRAG_REGION_HEIGHT,
  reserveLeft = 0,
  reserveRight = 0,
}: WindowDragRegionProps) {
  const style: AppRegionStyle = {
    height: `${height}px`,
    left: reserveLeft ? `${reserveLeft}px` : 0,
    right: reserveRight ? `${reserveRight}px` : 0,
    WebkitAppRegion: 'drag',
  }

  return (
    <div
      aria-hidden="true"
      data-testid="window-drag-region"
      // eslint-disable-next-line tabtin/no-design-system-violations -- z-0 为窗口拖拽区基线层（置于系统控件之下），属局部堆叠基准，语义 z scale 不适用
      className={cn('app-region-drag absolute top-0 z-0 select-none bg-transparent', className)}
      style={style}
    />
  )
}

// 用于侧边栏顶部的拖拽区域
export function SidebarDragRegion({
  className,
  excludeRight = 0
}: {
  className?: string
  excludeRight?: number
}) {
  return (
    <DragRegion
      height={WINDOW_DRAG_REGION_HEIGHT}
      className={cn(
        'absolute top-0 left-0 right-0 z-sticky',
        className
      )}
      style={excludeRight ? { right: `${excludeRight}px` } : undefined}
    />
  )
}
