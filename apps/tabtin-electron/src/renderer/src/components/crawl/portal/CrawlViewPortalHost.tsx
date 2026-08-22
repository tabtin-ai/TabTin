import React, { useEffect, useRef } from 'react'
import { useCrawlViewPortal, type CrawlViewSlotSource } from './CrawlViewPortalContext'

export interface CrawlViewPortalHostProps extends React.HTMLAttributes<HTMLDivElement> {
  viewId: string
  isActive?: boolean
  priority?: number
  source?: CrawlViewSlotSource
  enabled?: boolean
  onInteraction?: () => void
}

/**
 * CrawlViewPortalHost - Crawl View Portal 的宿主组件
 *
 * ⚠️ 重要设计决策：
 * - 使用 useEffect 而非 useLayoutEffect，避免同步更新导致的循环
 * - 使用 requestAnimationFrame 延迟注册，让 React 完成渲染批次
 * - 使用 mountedRef 追踪组件挂载状态，避免在卸载后更新
 */
export const CrawlViewPortalHost: React.FC<CrawlViewPortalHostProps> = ({
  viewId,
  isActive = true,
  priority = 0,
  source = 'unknown',
  enabled = true,
  onInteraction,
  ...props
}) => {
  const { registerSlot, unregisterSlot } = useCrawlViewPortal()
  const divRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)

  // ⭐ 使用 useEffect 而非 useLayoutEffect
  // 这允许 React 完成当前渲染周期后再更新 slots 状态
  // 打破了同步更新导致的无限循环
  useEffect(() => {
    mountedRef.current = true
    const element = divRef.current

    // 延迟注册，让 React 完成当前渲染批次
    const timeoutId = requestAnimationFrame(() => {
      if (!mountedRef.current || !element) return
      registerSlot(viewId, {
        element,
        isActive: enabled ? isActive : false,
        priority,
        source
      })
    })

    return () => {
      mountedRef.current = false
      cancelAnimationFrame(timeoutId)
      if (element) {
        unregisterSlot(viewId, element)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewId, enabled, isActive, priority, source])

  return (
    <div
      ref={divRef}
      data-crawl-view-slot={viewId}
      onPointerDownCapture={() => onInteraction?.()}
      onFocusCapture={() => onInteraction?.()}
      onKeyDownCapture={() => onInteraction?.()}
      {...props}
    />
  )
}

CrawlViewPortalHost.displayName = 'CrawlViewPortalHost'
