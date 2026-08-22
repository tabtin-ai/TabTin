/**
 * CrawlspaceLayout - 上下分栏布局组件
 *
 * 通用的上下分屏布局，内置拖拽手柄
 * 适用于所有抓取工作模式
 *
 * 从 WorkspaceSplitLayout 迁移，重命名为 Crawlspace 避免命名冲突
 */

import React, { useCallback, useEffect, useMemo, useRef, useState, useId } from 'react'
import type { ReactNode } from 'react'
import { GripVertical } from 'lucide-react'
import {
  Group,
  Panel,
  Separator,
  type GroupImperativeHandle,
  type PanelSize,
} from 'react-resizable-panels'
import { cn } from '../../utils/cn'

export interface CrawlspaceLayoutProps {
  /** 上半部分内容（通常是网页预览） */
  top: ReactNode
  /** 下半部分内容（通常是操作面板） */
  bottom: ReactNode
  /** 容器样式类名 */
  className?: string
  /** 上半部分样式类名 */
  topClassName?: string
  /** 下半部分样式类名 */
  bottomClassName?: string
  /** 拖拽手柄样式类名 */
  handleClassName?: string
  /** 受控的比例值（0-1，上半部分占比） */
  ratio?: number
  /** 默认比例（非受控时使用） */
  defaultRatio?: number
  /** 比例变化回调 */
  onRatioChange?: (ratio: number) => void
  /** 最小比例 */
  minRatio?: number
  /** 最大比例 */
  maxRatio?: number
  /** 双击手柄回调 */
  onDoubleClick?: () => void
  /** 手柄图标（可自定义） */
  handleIcon?: ReactNode
  /** 拖拽开始回调（用于上层埋点） */
  onResizeStart?: (ratio: number) => void
  /** 拖拽结束回调（用于上层埋点） */
  onResizeEnd?: (ratio: number) => void
  /** 拖拽取消回调（用于上层埋点） */
  onResizeCancel?: (ratio: number) => void
  /** 是否禁用拖拽手柄 */
  disableHandle?: boolean
  /** 是否隐藏上半部分 */
  topHidden?: boolean
  /** 是否隐藏下半部分 */
  bottomHidden?: boolean
}

/**
 * CrawlspaceLayout 组件
 */
export const CrawlspaceLayout: React.FC<CrawlspaceLayoutProps> = ({
  top,
  bottom,
  className,
  topClassName,
  bottomClassName,
  handleClassName,
  ratio,
  defaultRatio = 0.6,
  onRatioChange,
  minRatio = 0.3,
  maxRatio = 0.9,
  onDoubleClick,
  handleIcon,
  onResizeStart,
  onResizeEnd,
  onResizeCancel,
  disableHandle = false,
  topHidden = false,
  bottomHidden = false,
}) => {
  const [internalRatio, setInternalRatio] = useState(defaultRatio)
  const [isDragging, setIsDragging] = useState(false)
  const groupRef = useRef<GroupImperativeHandle | null>(null)
  const isSeparatorDraggingRef = useRef(false)
  const idSeed = useId().replace(/[:]/g, '')
  const topPanelId = `crawlspace-layout-top-${idSeed}`
  const bottomPanelId = `crawlspace-layout-bottom-${idSeed}`

  const effectiveRatio = useMemo(() => {
    if (typeof ratio === 'number') {
      return ratio
    }
    return internalRatio
  }, [ratio, internalRatio])

  const clampRatio = (value: number) => Math.max(minRatio, Math.min(maxRatio, value))

  const updateRatio = useCallback((value: number) => {
    const next = clampRatio(value)
    onRatioChange?.(next)
    if (typeof ratio !== 'number') {
      setInternalRatio(next)
    }
  }, [maxRatio, minRatio, onRatioChange, ratio])

  const handleReset = () => {
    updateRatio(defaultRatio)
    onDoubleClick?.()
  }

  const showHandle = !disableHandle && !topHidden && !bottomHidden

  const readCurrentTopRatio = useCallback(() => {
    const layout = groupRef.current?.getLayout()
    if (!layout) {
      return clampRatio(effectiveRatio)
    }
    const topPercent = layout[topPanelId]
    if (typeof topPercent !== 'number') {
      return clampRatio(effectiveRatio)
    }
    return clampRatio(topPercent / 100)
  }, [effectiveRatio, maxRatio, minRatio, topPanelId])

  const syncControlledRatioToV4 = useCallback(() => {
    if (typeof ratio !== 'number') return
    const next = clampRatio(ratio)
    groupRef.current?.setLayout({
      [topPanelId]: next * 100,
      [bottomPanelId]: (1 - next) * 100,
    })
  }, [bottomPanelId, maxRatio, minRatio, ratio, topPanelId])

  useEffect(() => {
    if (topHidden || bottomHidden) return
    syncControlledRatioToV4()
  }, [bottomHidden, syncControlledRatioToV4, topHidden])

  useEffect(() => {
    return () => {
      if (!isSeparatorDraggingRef.current) return
      isSeparatorDraggingRef.current = false
      setIsDragging(false)
      onResizeCancel?.(readCurrentTopRatio())
    }
  }, [onResizeCancel, readCurrentTopRatio])

  useEffect(() => {
    if (showHandle) return
    if (!isSeparatorDraggingRef.current) return
    isSeparatorDraggingRef.current = false
    setIsDragging(false)
    onResizeCancel?.(readCurrentTopRatio())
  }, [onResizeCancel, readCurrentTopRatio, showHandle])

  const defaultHandleIcon = (
    <GripVertical
      className="w-4 h-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-data-[separator=drag]:opacity-100"
    />
  )

  if (topHidden || bottomHidden || disableHandle) {
    return (
      <div className={cn('crawl-workspace flex flex-col h-full', className)}>
        {!topHidden && (
          <div
            className={cn('relative overflow-hidden', topClassName)}
            style={{ height: bottomHidden ? '100%' : `${effectiveRatio * 100}%` }}
          >
            {top}
          </div>
        )}

        {!bottomHidden && (
          <div
            className={cn('overflow-hidden', bottomClassName)}
            style={{ height: topHidden ? '100%' : `${(1 - effectiveRatio) * 100}%` }}
          >
            {bottom}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cn('crawl-workspace flex flex-col h-full', className)}>
      <Group
        orientation="vertical"
        className="h-full w-full overflow-hidden"
        groupRef={groupRef}
      >
        <Panel
          id={topPanelId}
          className={cn('relative overflow-hidden', topClassName)}
          minSize={`${minRatio * 100}%`}
          maxSize={`${maxRatio * 100}%`}
          defaultSize={`${clampRatio(effectiveRatio) * 100}%`}
          onResize={(panelSize: PanelSize) => {
            updateRatio(panelSize.asPercentage / 100)
          }}
        >
          {top}
        </Panel>

        <Separator
          className={cn(
            'drag-handle h-2 bg-transparent hover:bg-brand-400/40 data-[separator=drag]:bg-brand-500 cursor-ns-resize flex items-center justify-center transition-colors group',
            isDragging && 'bg-brand-500',
            handleClassName,
          )}
          onDoubleClick={handleReset}
          onPointerDown={() => {
            isSeparatorDraggingRef.current = true
            setIsDragging(true)
            onResizeStart?.(readCurrentTopRatio())
          }}
          onPointerUp={() => {
            if (!isSeparatorDraggingRef.current) return
            isSeparatorDraggingRef.current = false
            setIsDragging(false)
            onResizeEnd?.(readCurrentTopRatio())
          }}
          onPointerCancel={() => {
            if (!isSeparatorDraggingRef.current) return
            isSeparatorDraggingRef.current = false
            setIsDragging(false)
            onResizeCancel?.(readCurrentTopRatio())
          }}
          style={{ cursor: 'ns-resize' }}
        >
          {handleIcon || defaultHandleIcon}
        </Separator>

        <Panel
          id={bottomPanelId}
          className={cn('overflow-hidden', bottomClassName)}
          minSize={`${(1 - maxRatio) * 100}%`}
          maxSize={`${(1 - minRatio) * 100}%`}
          defaultSize={`${(1 - clampRatio(effectiveRatio)) * 100}%`}
        >
          {bottom}
        </Panel>
      </Group>
    </div>
  )
}
